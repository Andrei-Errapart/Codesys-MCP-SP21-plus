# Architecture

## Problem Statement

The original `@codesys/mcp-toolkit` spawns a new headless CODESYS process (`--noUI`) for every MCP tool call. This has two limitations:

1. **No UI visibility** — the user cannot see what the AI is doing to their project
2. **Project locking** — if the user opens CODESYS manually, the project file is locked and MCP tools fail

The desired workflow: a single CODESYS instance with its UI open, where MCP tool commands execute in the same process and changes appear in real-time.

## Architecture Overview

```
+-------------------------------------+
|      MCP Client (Claude Code)       |
+------------------+------------------+
                   | MCP Protocol (stdio)
+------------------v------------------+
|    Node.js MCP Server               |
|                                     |
|  bin.ts  -> CLI entry point         |
|  server.ts -> MCP tools/resources   |
|  launcher.ts -> Process management  |
|  ipc.ts -> File-based IPC           |
|  headless.ts -> Fallback mode       |
|  script-manager.ts -> Templates     |
+------------------+------------------+
                   | File-based IPC (persistent)
                   | OR spawn-per-command (headless)
+------------------v------------------+
|    CODESYS.exe                      |
|  watcher.py running inside via      |
|  --runscript (persistent mode)      |
+-------------------------------------+
```

## IPC Protocol

### Directory Layout

Each session creates a unique directory under `os.tmpdir()`:

```
%TEMP%/codesys-mcp-sp21-plus/<sessionId>/
  commands/           Node.js writes here
    <requestId>.py              Script to execute
    <requestId>.command.json    Command trigger file
  results/            Watcher writes here
    <requestId>.result.json     Execution result
  watcher.py          Interpolated watcher script
  ready.signal        Written by watcher on startup
  terminate.signal    Written by Node.js for shutdown
```

### Command File Format

`<requestId>.command.json`:
```json
{
  "requestId": "uuid-v4",
  "scriptPath": "/path/to/commands/<requestId>.py",
  "timestamp": 1700000000000
}
```

### Result File Format

`<requestId>.result.json`:
```json
{
  "requestId": "uuid-v4",
  "success": true,
  "output": "captured stdout from script execution",
  "error": "",
  "timestamp": 1700000000.123
}
```

### Write Ordering (Atomicity)

All files use atomic writes: write to `.tmp`, `fsync`, then `rename`.

Command submission order:
1. Write `<requestId>.py` (script content) -> fsync -> rename
2. Write `<requestId>.command.json.tmp` -> fsync -> rename to `.command.json`

The watcher triggers on `.command.json` appearance. Since the `.py` file is written and renamed first, it is guaranteed to exist when the watcher reads the command.

### Progressive Polling

Node.js polls for result files with exponential backoff:
- Initial interval: 100ms
- Doubles each poll: 100, 200, 400, 800, 1000ms
- Capped at 1000ms
- Default timeout: 60s (120s for compile)

## Watcher Script

The watcher (`src/scripts/watcher.py`) runs inside CODESYS via `--runscript` and provides the bridge between Node.js IPC and the CODESYS scripting API.

### Polling Loop

```python
while True:
    if check_terminate():
        break
    command_files = scan_commands_dir()
    if command_files:
        process_command(command_files[0])  # one per iteration
    time.sleep(0.05)  # 50ms yield to UI thread
```

The 50ms sleep interval balances responsiveness (commands processed within ~50ms) against UI thread availability (CODESYS UI stays responsive).

### Script Execution via exec()

Each command script is executed with `exec(script_code, exec_globals)` where `exec_globals` is a fresh dictionary:

```python
exec_globals = {
    '__builtins__': __builtins__,
    'sys': sys,
    'os': os,
    'time': time,
    'traceback': traceback,
    'shutil': __import__('shutil'),
}
```

This provides:
- **Namespace isolation** — variables from script A are not visible to script B
- **CODESYS API access** — `scriptengine` is available via `import scriptengine` because the watcher runs within the CODESYS scripting context (it's already in `sys.modules`)
- **Standard library access** — common modules pre-loaded in globals

### SystemExit Handling

CODESYS scripts use `sys.exit(0)` for success and `sys.exit(1)` for failure. The watcher catches `SystemExit` to prevent CODESYS from closing:

| Exit code | Mapping |
|-----------|---------|
| `None` or `0` | Success |
| Non-zero int | Failure |
| String | Failure (string is the error message) |

Output markers (`SCRIPT_SUCCESS` / `SCRIPT_ERROR`) take priority over exit codes when both are present.

### Output Capture

The `OutputCapture` class redirects `sys.stdout` and `sys.stderr` during script execution:

```python
class OutputCapture:
    def __init__(self):
        self._buffer = []
    def write(self, s):
        self._buffer.append(str(s))
    def getvalue(self):
        return ''.join(self._buffer)
```

Original stdout/stderr are saved and restored in a `try/finally` block, guaranteeing restoration even on unexpected exceptions. This class works across CPython and IronPython (CODESYS uses IronPython).

## Script Template System

Python scripts are stored as templates in `src/scripts/` with `{PLACEHOLDER}` tokens. The `ScriptManager` handles:

1. **Loading** — reads `.py` files from disk on every call (no cache, so edits to `dist/scripts/` are picked up live)
2. **Interpolation** — replaces `{KEY}` per the contract below
3. **Helper prepending** — shared functions (`unicode_text` always; `ensure_project_open`, `find_object_by_path` on request) prepended before the main script
4. **CRLF normalisation** — IronPython 2.7's `exec()` rejects CRLF inside triple-quoted docstrings

### Interpolation contract

The template decides how a value is treated. There are exactly two forms:

| Form | Behaviour |
|------|-----------|
| `X = "{KEY}"` | **Quoted.** The whole construct — including any `r`/`u` prefix and the single-quote spelling — is replaced by a fully escaped Python literal. Arbitrary user text is safe here. |
| `X = {KEY}` | **Bare.** Inserted verbatim. The caller is supplying a Python expression (`True`, an int, a base64 payload, a list literal). Never pass raw user text. |

`pyStringLiteral` (`src/py-literal.ts`) does the escaping, and it guarantees two things:

- **Nothing escapes the literal.** Quotes, backslashes, newlines and control characters are all escaped. A value ending in a backslash (`C:\exports\`) or a quote is no longer a `SyntaxError`.
- **The output is pure ASCII.** Non-ASCII becomes `\uXXXX` inside a `u"..."` literal. This matters because CODESYS reads script source with a PEP-263-derived encoding and, in headless mode, writes stdout through `Encoding.Default` (the system ANSI codepage). Keeping generated source ASCII-only removes both hazards.

Escaping lives here, in one place, rather than at the ~150 call sites — a contract spread that thin gets forgotten, and it was: a POU name of `x"; import os; os.system("calc"); y = "z` used to become live code in the generated script. `tests/unit/template-placeholder-safety.test.ts` pins the set of bare placeholders so a new template can't reopen the hole by accident.

### Bulk text: base64, not literals

Declaration and implementation bodies do **not** ride in string literals at all. `set_pou_code`, `create_pou`, `create_method` and `create_gvl` pass them as base64-of-UTF-8 (`toBase64Utf8` in `server.ts`, decoded by `decode_b64_utf8` in `unicode_text.py`). `get_all_pou_code` goes further and hands off a PLCopen XML file path, so the payload never touches stdout.

This is why: an earlier form embedded the declaration in a `"""..."""` literal, which (a) broke outright on a declaration ending in a double quote and (b) had no `u` prefix, so non-ASCII became an IronPython 2.7 byte string and reached the .NET API as mojibake.

### Helper Scripts

Two helper scripts are prepended to most tool scripts:

- **`ensure_project_open.py`** — opens a project file if not already open, with retry logic (3 attempts, 2s delay)
- **`find_object_by_path.py`** — navigates the CODESYS project tree to find objects by path (e.g., `Application/MyPOU`)

## Lifecycle Management

### Launch Sequence

1. Validate CODESYS executable exists
2. Generate session UUID
3. Create IPC directory with `commands/` and `results/` subdirectories
4. Load `watcher.py` template, interpolate `{IPC_BASE_DIR}`
5. Write interpolated watcher to session directory
6. Spawn: `CODESYS.exe --profile="..." --runscript="watcher.py"` (detached, UI visible)
7. `process.unref()` so Node.js doesn't wait for CODESYS
8. Poll for **`engine.signal`** (max 60s, every 500ms)
9. Record CODESYS's real PID from that signal, and start the health monitor (5s interval)

### Two signals, not one

`ready.signal` means only *"the watcher script started"* — it is written before `import scriptengine`. `engine.signal` is written after that import succeeds, and is what the launcher actually gates on.

The distinction is load-bearing. If the import throws (scripting plugin missing, license/profile problem), the watcher writes `FATAL:` to `watcher_error.txt` and exits without ever entering the poll loop. Gating on `ready.signal` alone reported a healthy CODESYS whose every subsequent command then timed out with no explanation. On failure the launcher now surfaces the `FATAL:` line, and kills the CODESYS it spawned rather than leaving an orphan for the conflict guard to trip over forever.

`engine.signal` also carries CODESYS's own PID, taken from `os.getpid()` *inside* the process. That is the only reliable source: the launcher spawns through `shell: true`, so `child.pid` is the `cmd.exe` wrapper. Killing the wrapper leaves the IDE running.

### Shutdown Sequence

1. Write `terminate.signal`
2. Wait up to 5s for process exit (poll every 500ms)
3. If still alive: `SIGTERM`, wait 2s, then `SIGKILL`
4. Clean up IPC directory

### Health Monitoring

A `setInterval` runs every 5 seconds. On process death (`process.kill(pid, 0)` against CODESYS's real PID):
- State transitions to `error`
- `lastError` is set with a descriptive message
- Registered `onStateChange` callbacks are invoked
- Monitor stops itself

**Liveness is not enough.** The characteristic CODESYS failure is not a crash but a freeze: a stuck transactional auto-save parks a thread in a native `CopyFile` P/Invoke, it never reaches a GC-safe point, and the CLR's garbage collector suspends every managed thread — permanently. The process keeps its PID and answers `kill(pid, 0)` perfectly happily while being completely unresponsive, and the watcher's polling loop is frozen along with everything else, so commands stop being consumed with no error at all.

The monitor therefore also probes `IsHungAppWindow` (via PowerShell `.Responding`) and warns once CODESYS has been unresponsive for 30s. Recovery is kill-and-relaunch, which is safe: the save is transactional, so the last good `.project` on disk is intact and CODESYS offers journal recovery on next open.

Full diagnosis, including the ruled-out hypotheses and the AV-exclusion prevention step: `C:\SVN\codesys\doc\CodesysUiHang.md`.

## Concurrency Model

### Async Mutex

The `IpcClient` uses an async mutex to serialize commands. Only one command can be in-flight at a time. This prevents:
- Race conditions in the CODESYS scripting API (not thread-safe)
- File system conflicts in the IPC directory
- Interleaved script output

When multiple tool calls arrive concurrently, they queue and execute sequentially.

### Watcher Single-Threaded Processing

The watcher processes one command per polling iteration. If multiple `.command.json` files exist, they're sorted alphabetically and processed in order.

## Headless Fallback

When persistent mode is unavailable, the `HeadlessExecutor` provides the same `ScriptExecutor` interface using spawn-per-command:

1. Write script to temp file
2. Spawn `CODESYS.exe --profile="..." --noUI --runscript="script.py"` with `windowsHide: true`
3. Capture stdout/stderr
4. Parse `SCRIPT_SUCCESS` / `SCRIPT_ERROR` markers
5. Return `IpcResult`

Fallback activates when:
- `--mode headless` is specified
- Persistent launch fails and `--fallback-headless` is explicitly opted in (off by default)
- Server starts with `--no-auto-launch` before `launch_codesys` is called

## Differences from Original Toolkit

| Aspect | @codesys/mcp-toolkit | codesys-mcp-sp21-plus |
|--------|---------------------|----------------------|
| CODESYS UI | Hidden (`--noUI`) | Visible (persistent) or hidden (headless) |
| Process lifetime | New process per command | Single long-running process |
| IPC mechanism | Spawn + stdout | File-based polling |
| Project locking | Blocks if user opens CODESYS | Shares the same instance |
| Real-time feedback | None | Changes visible in UI |
| Startup overhead | ~10-30s per command | ~10-30s once, then <100ms per command |
| Management tools | None | `launch_codesys`, `shutdown_codesys`, `get_codesys_status` |

## Security Considerations

- **Temp directory** — IPC files are created in the user's temp directory with default permissions. Note that command `.py` files transiently contain project paths and POU source.
- **Script injection** — closed centrally in `ScriptManager.interpolate`: every quoted placeholder becomes a fully escaped Python literal, and bare placeholders are pinned by a test. See the interpolation contract above. The `exec()` context has access to the full CODESYS scripting API, which is the intended design — so a value reaching it as *code* rather than *data* is a real escalation, not a cosmetic one.
- **No baked-in credentials** — `restart_runtime_ssh` and `read_running_version_ssh` take host/user/password from arguments or `CODESYS_PLC_*` environment variables. Earlier versions shipped a working host, username and password as literal defaults, which put them in the npm tarball and in the MCP tool schema sent to the model provider on every session. Don't reintroduce defaults here: anything in this repo is public.
- **SSH host keys** — verified trust-on-first-use and pinned in `~/.codesys-mcp/known_hosts`; a changed key aborts the connection. Without this, password auth against an mDNS name (`*.local`, unauthenticated and spoofable on a flat plant network) hands the SSH and sudo passwords to whoever answers.
- **Remote command construction** — `service` and `bootAppPath` are charset-validated before being interpolated into a remote `sudo` command, because the *remote* login shell parses that string and local quoting cannot help. Git operations use `execFileSync` with an argv array, so no path can be interpreted as shell syntax.
- **Localhost only** — IPC is file-based with no network exposure. The MCP server communicates via stdio only.
- **Process isolation** — CODESYS is spawned as a detached process. The Node.js server can crash and restart without affecting CODESYS (though a new session would be created).
