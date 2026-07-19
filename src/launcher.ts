/**
 * CODESYS launcher — spawns CODESYS with UI and watcher script,
 * tracks process lifecycle, delegates to IPC for command execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { LauncherConfig, LauncherStatus, CodesysState, IpcResult, ScriptExecutor } from './types';
import { IpcClient, DEFAULT_IPC_CONFIG } from './ipc';
import { ScriptManager } from './script-manager';
import { launcherLog } from './logger';
import {
  SESSION_DIR_PREFIX,
  AdoptCandidate,
  acquireOwnerLock,
  findAdoptCandidates,
  gcDeadSessions,
  releaseOwnerLock,
} from './session-adopt';

export interface RunningCodesys {
  pid: number;
  exePath: string;
}

/**
 * Returns every CODESYS.exe currently running on this Windows machine, with
 * the absolute path of its image file alongside the PID.
 *
 * Used by the launcher's pre-spawn guard and the shutdown_codesys orphan
 * killer. Both filter the list by the configured --codesys-path so that:
 *
 *   - Multiple CODESYS installs (e.g. SP21 + SP22) can run side-by-side.
 *     CODESYS supports parallel instances of *different* installs; only
 *     two instances of the *same* install on the *same* project trigger
 *     the "project is currently in use" file-lock modal.
 *   - shutdown_codesys never accidentally kills a CODESYS instance the
 *     user owns (different install) or that belongs to a different MCP
 *     server entry pointed at a different exe.
 *
 * Implementation: PowerShell Get-Process gives us {Id, Path} reliably.
 * tasklist doesn't expose ExecutablePath; WMIC is deprecated on modern
 * Windows. PowerShell's ~200ms cold start is fine at launch time.
 *
 * Returns an empty list on non-Windows or if PowerShell fails (we treat
 * that as "can't tell" rather than blocking the spawn; the user retains
 * the option to close manually if there really is a conflict).
 */
function findRunningCodesys(): RunningCodesys[] {
  if (process.platform !== 'win32') return [];
  try {
    // ConvertTo-Json emits a single object when the collection has one
    // element, an array otherwise. -AsArray would normalise but isn't
    // available in PS5.1, so we coerce on the JS side.
    const ps =
      'Get-Process -Name CODESYS -ErrorAction SilentlyContinue ' +
      '| Select-Object -Property Id,Path ' +
      '| ConvertTo-Json -Compress';
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
    );
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const result: RunningCodesys[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { Id?: unknown; Path?: unknown };
      if (typeof e.Id !== 'number') continue;
      if (typeof e.Path !== 'string') continue;
      result.push({ pid: e.Id, exePath: e.Path });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Compare two Windows paths for equality. Case-insensitive; normalises
 * forward and back slashes; trims trailing separators.
 *
 * Exported so the launcher unit test can pin the matching behaviour.
 */
export function pathsEqual(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '').trim();
  return norm(a) === norm(b);
}

/**
 * Is the process alive but not pumping its message loop?
 *
 * A CODESYS hang is NOT a dead process. Per the ClrMD diagnosis in
 * C:\SVN\codesys\doc\CodesysUiHang.md, the usual freeze is a CLR
 * garbage collection that suspended every managed thread and can never
 * complete, because an auto-save thread is parked in a native CopyFile
 * P/Invoke and never reaches a GC-safe point. The process keeps its PID,
 * keeps its handles, and answers `process.kill(pid, 0)` perfectly happily
 * while being completely unresponsive -- so a liveness probe cannot see it.
 *
 * PowerShell's `.Responding` is `IsHungAppWindow` on the main window, which
 * is exactly the signal Windows itself uses. Returns null when we can't
 * tell (non-Windows, no main window, PowerShell failure) so callers can
 * distinguish "not hung" from "unknown".
 */
export function isProcessHung(pid: number): boolean | null {
  if (process.platform !== 'win32') return null;
  try {
    const ps =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($null -eq $p) { 'GONE' } ` +
      `elseif ($p.MainWindowHandle -eq 0) { 'NOWINDOW' } ` +
      `elseif ($p.Responding) { 'OK' } else { 'HUNG' }`;
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
    ).trim();
    if (out === 'HUNG') return true;
    if (out === 'OK') return false;
    return null;
  } catch {
    return null;
  }
}

/** Guidance appended whenever we report a hang or an unexplained timeout. */
const HANG_DOC_HINT =
  'CODESYS is alive but not responding (classic symptom: a stuck transactional ' +
  'auto-save wedging a CLR GC). Killing it is safe -- the save is transactional, ' +
  'so the last good .project on disk is intact and CODESYS offers journal ' +
  'recovery on next open. See C:\\SVN\\codesys\\doc\\CodesysUiHang.md for the ' +
  'full diagnosis and the AV-exclusion prevention step.';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
/**
 * How long an adoption probe waits for the watcher to answer. Generous
 * enough to ride out a command the IDE is already busy with, short enough
 * that a dead or wedged session doesn't stall startup.
 */
const ADOPT_PROBE_TIMEOUT_MS = 15_000;
const SHUTDOWN_WAIT_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
/** How long CODESYS must stay unresponsive before the monitor says so. */
const HANG_WARN_AFTER_MS = 30_000;

export class CodesysLauncher implements ScriptExecutor {
  private config: LauncherConfig;
  private state: CodesysState = 'stopped';
  /**
   * PID of the process we spawned. With shell:true on Windows this is the
   * cmd.exe wrapper, NOT CODESYS.exe -- use codesysPid for anything that
   * targets the IDE itself. Kept because /T tree-kills need the wrapper.
   */
  private pid: number | null = null;
  /**
   * CODESYS.exe's real PID, reported by the watcher from inside the process
   * via engine.signal. Null until the engine signals ready.
   */
  private codesysPid: number | null = null;
  private sessionId: string | null = null;
  private ipcDir: string | null = null;
  private ipcClient: IpcClient | null = null;
  private process: ChildProcess | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Who owns the CODESYS process this launcher is talking to.
   *
   *   'owned'    -- we spawned it; shutdown() may kill it.
   *   'detached' -- we spawned it but handed it to the user (--keep-alive).
   *   'adopted'  -- someone else spawned it and we picked it up (--adopt).
   *
   * Anything other than 'owned' latches shutdown() off. That matters more
   * than it looks: shutdown()'s orphan killer taskkills ANY same-install
   * CODESYS.exe it finds when it has no tracked PID, and cannot tell the
   * instance a human is working in from a leftover corpse.
   */
  private ownership: 'owned' | 'detached' | 'adopted' = 'owned';
  /**
   * Path of the project that was already open when we adopted a session, if
   * any. The human's project -- see assertProjectSwitchAllowed().
   */
  private adoptedProjectPath: string | null = null;
  private stateChangeCallbacks: Array<(state: CodesysState) => void> = [];

  constructor(config: LauncherConfig) {
    this.config = config;
  }

  /**
   * Find CODESYS.exe instances using the same install path as our config.
   * Public so the server can decide whether to soft-fail vs. propagate.
   */
  findConflictingInstances(): RunningCodesys[] {
    return findRunningCodesys().filter((p) =>
      pathsEqual(p.exePath, this.config.codesysPath)
    );
  }

  /**
   * Taskkill conflicting same-install CODESYS.exe processes. Returns the
   * PIDs that were killed. Used by launch({ killExisting: true }) and by
   * the launch_codesys MCP tool to resolve a conflict from chat.
   */
  killConflictingInstances(): number[] {
    const killed: number[] = [];
    for (const p of this.findConflictingInstances()) {
      try {
        execSync(`taskkill /PID ${p.pid}`, { timeout: 5000, stdio: 'ignore' });
        killed.push(p.pid);
      } catch {
        try {
          execSync(`taskkill /F /PID ${p.pid}`, { timeout: 5000, stdio: 'ignore' });
          killed.push(p.pid);
        } catch {
          // ignore -- caller will see the survivor in a follow-up scan
        }
      }
    }
    return killed;
  }

  /** Launch CODESYS with UI and watcher script */
  async launch(opts: { killExisting?: boolean } = {}): Promise<void> {
    if (this.state === 'ready' || this.state === 'launching') {
      launcherLog.warn(`Cannot launch: state is ${this.state}`);
      return;
    }

    this.lastError = null;

    // Validate CODESYS exe exists
    if (!fs.existsSync(this.config.codesysPath)) {
      const err = `CODESYS executable not found: ${this.config.codesysPath}`;
      this.setState('error');
      this.lastError = err;
      throw new Error(err);
    }

    // Reclaim %TEMP% from sessions whose CODESYS has since exited. --keep-alive
    // stops detach() from cleaning up after itself, so without this the
    // leftovers accumulate one directory per kept-alive session.
    this.sweepDeadSessions();

    // Prefer adopting a live watcher over spawning a second IDE. This is what
    // turns --keep-alive into a round trip: stop the server, work in the
    // window by hand, start the server again and pick the same session back
    // up. killExisting is an explicit instruction to get a *fresh* instance,
    // so it skips adoption entirely.
    if (this.config.adopt && !opts.killExisting) {
      try {
        if (await this.adopt()) return;
      } catch (err) {
        // Adoption is an optimisation; never let it block a normal launch.
        launcherLog.warn(
          `--adopt: adoption attempt failed (${err instanceof Error ? err.message : String(err)}); ` +
          `falling through to a normal launch.`
        );
      }
    }

    // Refuse to spawn a 2nd instance of the SAME CODESYS install. Different
    // installs (e.g. SP21 + SP22) coexist fine -- CODESYS supports parallel
    // instances of different exes and they don't share the file lock unless
    // they're opening the same .project. Two instances of the SAME exe, on
    // the other hand:
    //   - CODESYS-side: most installs enforce singleton-per-install and
    //     refuse the 2nd spawn (or attach to the existing instance silently),
    //     so we'd never get the IPC handshake.
    //   - Our side: even if the 2nd starts, this MCP server can't IPC into
    //     an instance it didn't spawn (no watcher attached).
    //
    // Earlier versions refused on ANY CODESYS.exe in tasklist, which broke
    // multi-install setups (the one the README documents). Filter by the
    // configured exe path so different installs are allowed through.
    let conflicting = this.findConflictingInstances();
    if (conflicting.length > 0 && opts.killExisting) {
      const killed = this.killConflictingInstances();
      launcherLog.info(`Killed ${killed.length} conflicting CODESYS PID(s): ${killed.join(', ')}`);
      // taskkill returns synchronously but Windows can take a tick longer
      // to actually evict the PID from the process table. If we re-scan
      // too eagerly we still see the corpse and falsely throw a conflict.
      // Poll until the killed PIDs are all gone (or 2s timeout).
      const killedSet = new Set(killed);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const stillAlive = this.findConflictingInstances();
        const ghosts = stillAlive.filter((p) => killedSet.has(p.pid));
        if (ghosts.length === 0) {
          conflicting = stillAlive;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
        conflicting = stillAlive; // ensures `conflicting` reflects last scan on timeout
      }
    }
    if (conflicting.length > 0) {
      const pids = conflicting.map((p) => p.pid).join(', ');
      const adoptNote = this.config.adopt
        ? // --adopt was on and we still got here, so adoption was tried and
          // declined. Say why it's possible rather than leaving the user to
          // wonder why the flag "didn't work".
          `--adopt is enabled but none of these instances offered an adoptable ` +
          `watcher: no session directory claims them, their watcher version ` +
          `differs from this build, another server holds the session, or the ` +
          `watcher did not answer (dead script, modal dialog, or a wedged IDE). ` +
          `The launcher log above records which. `
        : `This MCP server cannot share IPC with an instance it didn't spawn. ` +
          `If that instance was left open by a server running --keep-alive, ` +
          `restart this one with --adopt to take it over instead. `;
      const msg =
        `Refusing to launch: ${conflicting.length} CODESYS.exe instance(s) ` +
        `of the same install already running (PID(s): ${pids}, exe: ` +
        `${this.config.codesysPath}). ${adoptNote}` +
        `Close the existing window(s), or call ` +
        `launch_codesys with killExisting=true to taskkill them and retry. ` +
        `Other CODESYS installs are unaffected and may keep running.`;
      launcherLog.warn(msg);
      this.lastError = msg;
      this.setState('error');
      const err = new Error(msg) as Error & { code?: string; conflictingPids?: number[] };
      err.code = 'CODESYS_LAUNCH_CONFLICT';
      err.conflictingPids = conflicting.map((p) => p.pid);
      throw err;
    }

    // Fresh spawn: this launcher owns a process again, so shutdown() is live.
    this.ownership = 'owned';
    this.adoptedProjectPath = null;
    this.setState('launching');
    this.sessionId = uuidv4();
    this.ipcDir = path.join(os.tmpdir(), SESSION_DIR_PREFIX, this.sessionId);

    launcherLog.info(`Session ${this.sessionId} — IPC dir: ${this.ipcDir}`);

    // Create IPC client and directories
    this.ipcClient = new IpcClient({
      baseDir: this.ipcDir,
      ...DEFAULT_IPC_CONFIG,
    });
    await this.ipcClient.ensureDirectories();

    // Prepare watcher script with interpolated IPC path
    const scriptManager = new ScriptManager();
    const watcherTemplate = scriptManager.loadTemplate('watcher');
    // Pass the RAW path. ScriptManager.interpolate escapes it into a Python
    // literal itself; the manual backslash-doubling that used to be here now
    // double-escapes, and it was always wrong anyway -- it escaped for a
    // non-raw literal while the template used r"...".
    // RELEASE_IDLE_UI lands in the template as a bare Python literal, so it
    // must be spelled the way Python spells booleans -- String(true) would
    // interpolate the JavaScript "true" and raise NameError inside the IDE.
    const watcherContent = scriptManager.interpolate(watcherTemplate, {
      IPC_BASE_DIR: this.ipcDir,
      RELEASE_IDLE_UI: this.config.safeUi ? 'False' : 'True',
    });

    // Write interpolated watcher to IPC directory
    const watcherPath = path.join(this.ipcDir, 'watcher.py');
    fs.writeFileSync(watcherPath, watcherContent, 'utf-8');

    // Build CODESYS command
    const quotedExe = `"${this.config.codesysPath}"`;
    const profileArg = `--profile="${this.config.profileName}"`;
    const scriptArg = `--runscript="${watcherPath}"`;
    const fullCommand = `${quotedExe} ${profileArg} ${scriptArg}`;

    launcherLog.info(`Spawning: ${fullCommand}`);

    // Spawn CODESYS detached with UI visible
    const codesysDir = path.dirname(this.config.codesysPath);
    this.process = spawn(fullCommand, [], {
      detached: true,
      shell: true,
      windowsHide: false,
      stdio: 'ignore',
      cwd: codesysDir,
    });

    this.pid = this.process.pid ?? null;
    this.process.unref();

    launcherLog.info(`CODESYS spawned with PID ${this.pid}`);

    // Handle process exit
    this.process.on('exit', (code) => {
      launcherLog.warn(`CODESYS process exited with code ${code}`);
      if (this.state !== 'stopping') {
        this.lastError = `CODESYS exited unexpectedly (code ${code})`;
        this.setState('error');
      }
      this.pid = null;
      this.codesysPid = null;
      this.process = null;
    });

    // Poll for engine.signal -- NOT ready.signal. ready.signal only means
    // the watcher script started; engine.signal means `import scriptengine`
    // succeeded and commands can actually be served.
    const readyStart = Date.now();
    while (Date.now() - readyStart < READY_TIMEOUT_MS) {
      // Bail out early if the process is already gone, rather than burning
      // the remaining timeout and then overwriting the real cause with a
      // misleading "did not signal ready".
      // Read through a cast: the exit handler above assigns this
      // asynchronously, which TS's control-flow analysis cannot see.
      const exitError = this.lastError as string | null;
      if (this.state === 'error' && exitError !== null && exitError.startsWith('CODESYS exited')) {
        throw new Error(exitError);
      }

      const engine = await this.ipcClient.readEngineSignal();
      if (engine) {
        this.codesysPid = engine.pid;
        this.setState('ready');
        this.startedAt = Date.now();
        this.lastError = null;
        // Claim the session even on a normal launch: --keep-alive can hand
        // this very directory to a future server, and an unclaimed live
        // session is one another --adopt server could grab out from under us.
        if (this.ipcDir && this.sessionId) {
          acquireOwnerLock(this.ipcDir, {
            sessionId: this.sessionId,
            codesysPid: engine.pid,
            watcherVersion: engine.version,
          });
        }
        launcherLog.info(
          `CODESYS watcher is ready (watcher v${engine.version ?? '?'}, ` +
            `CODESYS PID ${engine.pid ?? 'unknown'}, shell PID ${this.pid})`
        );
        this.startHealthMonitor();
        return;
      }

      const fatal = this.ipcClient.readWatcherFatal();
      if (fatal) {
        // The watcher died on us -- almost always `import scriptengine`
        // failing. Surface it now instead of timing out with no explanation.
        this.lastError =
          `CODESYS started but the scripting engine failed to initialise:\n${fatal}`;
        break;
      }

      await this.sleep(READY_POLL_MS);
    }

    // Timeout or watcher fatal. Either way we must not leave the CODESYS we
    // spawned running: the conflict guard in launch() would then refuse every
    // subsequent attempt, wedging the server until someone passes
    // killExisting=true.
    if (!this.lastError) {
      const scriptStarted = await this.ipcClient.isReady();
      const hung = this.codesysPid !== null ? isProcessHung(this.codesysPid) : null;
      this.lastError =
        `Watcher did not signal ready within ${READY_TIMEOUT_MS}ms. ` +
        (scriptStarted
          ? 'The watcher script started but never got through `import scriptengine` ' +
            '-- check that the CODESYS scripting plugin is installed and licensed for ' +
            `profile "${this.config.profileName}".`
          : 'CODESYS never ran the watcher script at all -- it may be showing a ' +
            'modal (profile selection, update check, license nag) that blocks --runscript.') +
        (hung === true ? `\n${HANG_DOC_HINT}` : '');
    }

    const watcherLog = this.ipcClient.readWatcherError();
    if (watcherLog) {
      launcherLog.error(`watcher_error.txt contents:\n${watcherLog}`);
    }

    await this.killSpawnedTree('launch timed out');
    this.setState('error');
    throw new Error(this.lastError);
  }

  /**
   * Kill the process tree we spawned, wrapper included.
   *
   * `taskkill /T` walks children, which is what reaches CODESYS.exe through
   * the cmd.exe wrapper that shell:true gives us. Safe to call mid-save --
   * CODESYS commits projects transactionally, so the last good .project on
   * disk survives (see CodesysUiHang.md).
   */
  private async killSpawnedTree(reason: string): Promise<void> {
    const targets = [this.codesysPid, this.pid].filter(
      (p): p is number => typeof p === 'number'
    );
    if (targets.length === 0) return;
    launcherLog.warn(`Killing spawned CODESYS tree (${reason}): PIDs ${targets.join(', ')}`);
    for (const pid of targets) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000, stdio: 'ignore' });
        } catch {
          // Already gone, or never existed -- nothing else to try.
        }
      } else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* already gone */ }
      }
    }
    this.pid = null;
    this.codesysPid = null;
    this.process = null;
  }

  /**
   * Ask the watcher which project is currently primary.
   *
   * Doubles as the liveness ping for adoption: a result coming back proves
   * the watcher is polling *now*, which no signal file on disk can. A
   * timeout means the session is stale (watcher dead) or the IDE is wedged
   * (modal dialog open, or the CLR-GC freeze from CodesysUiHang.md) -- in
   * every one of those cases we must not adopt.
   *
   * Returns the primary project path, '' when no project is open, or null
   * when the watcher did not answer.
   */
  private async probePrimaryProject(
    client: IpcClient,
    timeoutMs: number
  ): Promise<string | null> {
    const probe = [
      'import sys',
      'try:',
      '    import scriptengine as se',
      '    _p = se.projects.primary',
      '    print("ADOPT_PRIMARY:%s" % (_p.path if _p is not None else ""))',
      'except Exception as _e:',
      '    print("ADOPT_PRIMARY:")',
      'print("SCRIPT_SUCCESS")',
    ].join('\n');

    try {
      const result = await client.sendCommand(probe, timeoutMs);
      if (!result.success) return null;
      const m = /^ADOPT_PRIMARY:(.*)$/m.exec(result.output);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  }

  /** WATCHER_VERSION of the watcher.py shipped in *this* build. */
  private shippedWatcherVersion(): string | null {
    try {
      const template = new ScriptManager().loadTemplate('watcher');
      const m = /^WATCHER_VERSION\s*=\s*["']([^"']+)["']/m.exec(template);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Take over a watcher session left behind by a previous server
   * (`--adopt`), rather than refusing to launch alongside it.
   *
   * Returns true when this launcher is now serving an adopted CODESYS, false
   * when nothing was adoptable and the caller should spawn normally. Never
   * throws: adoption is an optimisation, and any failure has to degrade into
   * the ordinary launch path.
   */
  async adopt(): Promise<boolean> {
    const liveSameInstall = new Set(this.findConflictingInstances().map((p) => p.pid));
    if (liveSameInstall.size === 0) return false;

    const candidates = findAdoptCandidates(liveSameInstall);
    if (candidates.length === 0) {
      launcherLog.info(
        `--adopt: ${liveSameInstall.size} same-install CODESYS.exe running but no ` +
        `session directory claims any of them. Nothing to adopt.`
      );
      return false;
    }

    const shipped = this.shippedWatcherVersion();
    for (const c of candidates) {
      const adopted = await this.tryAdoptCandidate(c, shipped);
      if (adopted) return true;
    }
    return false;
  }

  /** One candidate: version gate, then lock, then prove liveness. */
  private async tryAdoptCandidate(
    c: AdoptCandidate,
    shippedVersion: string | null
  ): Promise<boolean> {
    // Version gate. A kept-alive IDE keeps running the watcher.py it was
    // started with, so upgrading the package while that window is open would
    // otherwise have us drive an old watcher with new scripts. Refuse rather
    // than debug that later.
    if (shippedVersion !== null && c.watcherVersion !== null && c.watcherVersion !== shippedVersion) {
      launcherLog.warn(
        `--adopt: skipping session ${c.sessionId} -- watcher v${c.watcherVersion} but this ` +
        `build ships v${shippedVersion}. Restart CODESYS to pick up the current watcher.`
      );
      return false;
    }

    if (c.lock !== null) {
      launcherLog.info(
        `--adopt: session ${c.sessionId} is claimed by PID ${c.lock.ownerPid}; trying it anyway ` +
        `in case the claim is stale.`
      );
    }
    if (!acquireOwnerLock(c.ipcDir, {
      sessionId: c.sessionId,
      codesysPid: c.codesysPid,
      watcherVersion: c.watcherVersion,
    })) {
      launcherLog.info(`--adopt: session ${c.sessionId} is owned by a live server, skipping.`);
      return false;
    }

    const client = new IpcClient({ baseDir: c.ipcDir, ...DEFAULT_IPC_CONFIG });
    launcherLog.info(
      `--adopt: probing session ${c.sessionId} (CODESYS PID ${c.codesysPid}, watcher v${c.watcherVersion ?? '?'})...`
    );
    const primary = await this.probePrimaryProject(client, ADOPT_PROBE_TIMEOUT_MS);

    if (primary === null) {
      const hung = isProcessHung(c.codesysPid);
      launcherLog.warn(
        `--adopt: session ${c.sessionId} did not answer within ${ADOPT_PROBE_TIMEOUT_MS}ms. ` +
        (hung === true
          ? HANG_DOC_HINT
          : 'Its watcher is most likely dead (script cancelled or crashed) while CODESYS ' +
            'stays up, or a modal dialog is blocking the primary thread.')
      );
      releaseOwnerLock(c.ipcDir);
      return false;
    }

    this.ownership = 'adopted';
    this.sessionId = c.sessionId;
    this.ipcDir = c.ipcDir;
    this.ipcClient = client;
    this.codesysPid = c.codesysPid;
    this.pid = null; // we never spawned a shell wrapper for this one
    this.process = null;
    this.startedAt = Date.now();
    this.lastError = null;
    this.adoptedProjectPath = primary === '' ? null : primary;
    this.setState('ready');
    this.startHealthMonitor();

    launcherLog.info(
      `--adopt: adopted CODESYS PID ${c.codesysPid} (session ${c.sessionId}). ` +
      (this.adoptedProjectPath
        ? `Project currently open in the IDE: ${this.adoptedProjectPath}`
        : 'No project currently open in the IDE.')
    );
    return true;
  }

  /**
   * Refuse to yank a project out from under a human.
   *
   * ensure_project_open.py saves and closes whatever project is primary when
   * a script targets a different one. That is correct when the server owns
   * the IDE exclusively, but an adopted IDE has a person in it: the same code
   * path would silently commit their half-finished edits and close their
   * project on the first tool call that names something else.
   *
   * Self-healing by design: on a mismatch we re-probe the live IDE rather
   * than trusting what we recorded at adopt time. If the user has since
   * closed or switched the project themselves, the guard clears and the call
   * proceeds. Only a genuinely different project open *right now* blocks.
   *
   * Returns null to allow, or a message explaining the refusal.
   */
  async checkProjectSwitch(targetProjectPath: string): Promise<string | null> {
    if (this.ownership !== 'adopted') return null;
    if (this.adoptedProjectPath === null) return null;
    if (pathsEqual(targetProjectPath, this.adoptedProjectPath)) return null;
    if (this.state !== 'ready' || !this.ipcClient) return null;

    const primary = await this.probePrimaryProject(this.ipcClient, ADOPT_PROBE_TIMEOUT_MS);
    if (primary === null) {
      // Can't tell -- don't invent a refusal; the call will surface its own
      // timeout with better context than we can here.
      return null;
    }
    if (primary === '' || pathsEqual(primary, targetProjectPath)) {
      this.adoptedProjectPath = primary === '' ? null : primary;
      return null;
    }

    this.adoptedProjectPath = primary;
    return (
      `Refusing to switch projects in an adopted CODESYS.\n\n` +
      `The IDE (PID ${this.codesysPid ?? '?'}) currently has this project open:\n` +
      `  ${primary}\n` +
      `and this call targets:\n` +
      `  ${targetProjectPath}\n\n` +
      `This server adopted a CODESYS instance it did not start (--adopt), so that ` +
      `window may have a person working in it. Switching projects would save and ` +
      `close the open one -- committing any half-finished edits in it.\n\n` +
      `To proceed: close or switch the project in the CODESYS window yourself, then ` +
      `retry. This check clears itself as soon as the IDE is no longer holding a ` +
      `different project.`
    );
  }

  /**
   * Delete session directories whose CODESYS is gone. Called at launch; the
   * counterpart to detach() deliberately leaving directories behind.
   */
  sweepDeadSessions(): void {
    const live = new Set(findRunningCodesys().map((p) => p.pid));
    const removed = gcDeadSessions(live, this.ipcDir);
    if (removed.length > 0) {
      launcherLog.info(`Swept ${removed.length} dead session director(y|ies) from %TEMP%`);
    }
  }

  /**
   * Release CODESYS without stopping it (`--keep-alive`).
   *
   * Deliberately the inverse of shutdown(): no quit script, no terminate
   * signal, no IPC cleanup. The watcher script keeps running its
   * `system.delay()` loop -- that loop is what pumps the Windows message
   * loop and keeps the window interactive, so leaving it alive is what
   * hands the user a usable IDE rather than a frozen one.
   *
   * The session directory is left on disk on purpose: the watcher polls
   * `commands/` every 50ms, so deleting it here would leave
   * `os.listdir(COMMANDS_DIR)` throwing ~20x/second into the watcher log
   * for as long as the user keeps the IDE open. It lives under the OS temp
   * directory and is reclaimed with the rest of %TEMP%.
   *
   * The spawn is already `detached: true` + `unref()`, so the IDE survives
   * our exit by itself; all this method has to do is stop us from killing it.
   *
   * @returns the released PID and session dir, for logging by the caller.
   */
  detach(): { pid: number | null; ipcDir: string | null } {
    // Adopted instances come through here too: we don't own them either, and
    // they still hold the lock this process took at adopt time. Skipping them
    // would strand that lock on a dead PID until the stale-reclaim path
    // happened to notice.
    if (this.ownership === 'detached' || this.state === 'stopped' || this.state === 'stopping') {
      return { pid: null, ipcDir: null };
    }

    this.stopHealthMonitor();
    const pid = this.codesysPid ?? this.pid;
    const ipcDir = this.ipcDir;
    launcherLog.info(
      `Releasing CODESYS (PID ${pid ?? 'unknown'}, ${this.ownership}): keep-alive is on, so ` +
      `the IDE and its watcher stay running. Session dir left in place: ${ipcDir ?? 'none'}`
    );

    // Release the claim so the next server with --adopt can pick this session
    // up. Without this the session would be locked to a PID that no longer
    // exists, and only the stale-lock reclaim path could recover it.
    if (ipcDir) releaseOwnerLock(ipcDir);

    // Drop our handles on the process without touching it. Ownership changes
    // first so a later shutdown() can't walk the orphan-killer path and
    // taskkill the very instance we just handed to the user.
    this.ownership = 'detached';
    this.pid = null;
    this.codesysPid = null;
    this.process = null;
    this.ipcClient = null;
    this.ipcDir = null;
    this.sessionId = null;
    this.setState('stopped');

    return { pid, ipcDir };
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    // An instance we don't own belongs to the user (detached via
    // --keep-alive) or to whoever spawned it (adopted via --adopt). Never
    // kill it. Without this the orphan-killer below would taskkill it on
    // sight, since it matches "same install, no tracked PID" exactly.
    if (this.ownership !== 'owned') {
      if (this.ownership === 'adopted' && this.ipcDir) {
        // Adopted sessions still hold a lock at shutdown time (detach()
        // releases its own). Drop it so the session stays adoptable.
        releaseOwnerLock(this.ipcDir);
        this.stopHealthMonitor();
        launcherLog.info(
          `Releasing adopted CODESYS (PID ${this.codesysPid ?? 'unknown'}) without stopping it.`
        );
        this.ipcClient = null;
        this.ipcDir = null;
        this.codesysPid = null;
        this.setState('stopped');
        return;
      }
      launcherLog.info(`shutdown() ignored: launcher ownership is '${this.ownership}'`);
      return;
    }

    // Orphan-killing fallback: if the launcher itself has no tracked PID
    // (state stopped/error after a fresh MCP server start) but a CODESYS.exe
    // is alive on the box from a previous session, the previous early-return
    // would say "shutdown_codesys success" and do nothing. This left the
    // launcher's refuse-on-duplicate guard permanently blocking new spawns.
    // Now we taskkill any orphans we can find before the early-return so the
    // tool actually does something useful in this state.
    if (this.state === 'stopped' || this.state === 'stopping') {
      if (this.pid === null) {
        // Only kill orphans of OUR configured exe -- never touch a CODESYS
        // instance from a different install (could be the user's own work
        // or owned by a different MCP server entry).
        const orphans = findRunningCodesys().filter((p) =>
          pathsEqual(p.exePath, this.config.codesysPath)
        );
        if (orphans.length > 0) {
          const orphanPids = orphans.map((p) => p.pid);
          launcherLog.info(`shutdown_codesys: launcher has no tracked PID but found ${orphanPids.length} orphan CODESYS.exe of the configured install (PIDs: ${orphanPids.join(', ')}). Force-killing.`);
          for (const pid of orphanPids) {
            try {
              execSync(`taskkill /PID ${pid}`, { timeout: 5000, stdio: 'ignore' });
            } catch { /* ignore graceful failures, force-kill below */ }
          }
          // Give them a moment to close gracefully
          await this.sleep(2_000);
          const stillAlive = findRunningCodesys()
            .filter((p) => pathsEqual(p.exePath, this.config.codesysPath))
            .map((p) => p.pid);
          for (const pid of stillAlive) {
            try {
              execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, stdio: 'ignore' });
            } catch { /* nothing else to try */ }
          }
        }
      }
      return;
    }

    // Capture this BEFORE setState('stopping') overwrites it. The old
    // `this.state !== 'error'` test below ran after the transition and so
    // was always true -- meaning every shutdown of an already-dead CODESYS
    // still dispatched the quit script and burned its full 10s timeout.
    const wasError = this.state === 'error';

    this.setState('stopping');
    this.stopHealthMonitor();

    // Try to close projects and quit CODESYS gracefully via script. Skipped
    // when CODESYS is known dead or wedged -- a hung IDE cannot answer, and
    // waiting on it just delays the kill.
    const hung = this.isHung() === true;
    if (hung) {
      launcherLog.warn(`Skipping graceful quit script: ${HANG_DOC_HINT}`);
    }
    if (this.ipcClient && !wasError && !hung) {
      try {
        launcherLog.info('Sending quit script to close projects and exit CODESYS...');
        await this.ipcClient.sendCommand(`
import sys
try:
    import scriptengine as se
    # Close all open projects without saving (save should be done before shutdown)
    for p in list(se.projects):
        try:
            p.close()
        except:
            pass
    print("Projects closed")
except:
    pass
# Request CODESYS to quit
try:
    import scriptengine as se
    se.system.exit()
except:
    pass
print("SCRIPT_SUCCESS")
sys.exit(0)
`, 10_000);
      } catch {
        launcherLog.debug('Quit script timed out or failed (expected if CODESYS exits)');
      }
    }

    // Send terminate signal to watcher
    if (this.ipcClient) {
      try {
        await this.ipcClient.sendTerminate();
      } catch {
        launcherLog.warn('Failed to send terminate signal');
      }
    }

    // Wait for process exit
    if (this.pid !== null) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < SHUTDOWN_WAIT_MS) {
        if (!this.isRunning()) break;
        await this.sleep(500);
      }

      // Force kill if still alive. Target CODESYS's own PID -- the previous
      // version taskkill'd the cmd.exe wrapper, which left the IDE running.
      if (this.isRunning()) {
        launcherLog.warn('Force-killing CODESYS process');
        try {
          if (process.platform === 'win32') {
            const target = this.codesysPid ?? this.pid;
            if (target !== null) {
              try {
                // Graceful close (WM_CLOSE) first. A hung CODESYS will not
                // answer this -- that's what the /F escalation is for.
                execSync(`taskkill /PID ${target}`, { timeout: 5000, stdio: 'ignore' });
                await this.sleep(3_000);
              } catch { /* ignore */ }
            }
            if (this.isRunning()) {
              await this.killSpawnedTree('graceful close did not take');
            }
          } else if (this.process) {
            this.process.kill('SIGTERM');
            await this.sleep(2_000);
            if (this.isRunning() && this.process) {
              this.process.kill('SIGKILL');
            }
          }
        } catch {
          launcherLog.warn('Failed to kill CODESYS process');
        }
      }
    }

    // Clean up IPC directory
    if (this.ipcClient) {
      await this.ipcClient.cleanup();
    }

    this.pid = null;
    this.codesysPid = null;
    this.process = null;
    this.ipcClient = null;
    this.setState('stopped');
    launcherLog.info('Shutdown complete');
  }

  /** Execute a script through the IPC channel */
  async executeScript(content: string, timeoutMs?: number): Promise<IpcResult> {
    if (this.state !== 'ready' || !this.ipcClient) {
      throw new Error(`Cannot execute script: launcher state is '${this.state}'`);
    }
    return this.ipcClient.sendCommand(content, timeoutMs);
  }

  /** Get current launcher status */
  getStatus(): LauncherStatus {
    this.revalidateLaunchRefusal();
    return {
      state: this.state,
      // Report CODESYS's own PID -- the one that matches Task Manager --
      // rather than the cmd.exe wrapper we happen to have spawned.
      pid: this.codesysPid ?? this.pid,
      sessionId: this.sessionId,
      ipcDir: this.ipcDir,
      startedAt: this.startedAt,
      lastError: this.lastError,
      ownership: this.ownership,
      adoptedProjectPath: this.adoptedProjectPath,
    };
  }

  /**
   * If the launcher is parked in 'error' state because a previous launch
   * refused due to a foreign CODESYS, re-probe the process table. If those
   * conflicting PIDs are now gone, transition back to 'stopped' and clear
   * lastError so the next status call / launch attempt sees a fresh state.
   *
   * Without this, getStatus() returned a frozen snapshot of state+lastError,
   * so once "Refusing to launch" was cached, even closing the foreign
   * CODESYS wouldn't update the status -- only an MCP restart would.
   * Distinct from the launch()-time guard at line ~145 (which already
   * re-probes) because users hit `get_codesys_status` first to figure out
   * what's wrong, and a stale "Refusing to launch" is misleading.
   */
  private revalidateLaunchRefusal(): void {
    if (this.state !== 'error') return;
    if (!this.lastError?.startsWith('Refusing to launch:')) return;
    if (this.findConflictingInstances().length === 0) {
      launcherLog.info(
        'revalidateLaunchRefusal: cached "Refusing to launch" cleared -- ' +
        'no same-install CODESYS.exe currently in process table'
      );
      this.lastError = null;
      this.setState('stopped');
    }
  }

  /**
   * Check if CODESYS is still alive.
   *
   * Prefers the real CODESYS PID from engine.signal. Falling back to the
   * shell-wrapper PID is a last resort and is wrong in both directions: the
   * wrapper can outlive CODESYS, and CODESYS can outlive the wrapper.
   *
   * Liveness only. A hung CODESYS passes this -- see isProcessHung().
   */
  isRunning(): boolean {
    const pid = this.codesysPid ?? this.pid;
    if (pid === null) return false;
    try {
      process.kill(pid, 0); // Signal 0 = test if process exists
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when CODESYS is alive but wedged. Null when we can't tell.
   * Exposed so get_codesys_status can distinguish "busy" from "frozen".
   */
  isHung(): boolean | null {
    const pid = this.codesysPid;
    if (pid === null || !this.isRunning()) return null;
    return isProcessHung(pid);
  }

  /** Register callback for state changes */
  onStateChange(callback: (state: CodesysState) => void): void {
    this.stateChangeCallbacks.push(callback);
  }

  private setState(state: CodesysState): void {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      launcherLog.info(`State: ${prev} -> ${state}`);
      for (const cb of this.stateChangeCallbacks) {
        try { cb(state); } catch { /* ignore callback errors */ }
      }
    }
  }

  private startHealthMonitor(): void {
    let hungSince: number | null = null;
    this.healthInterval = setInterval(() => {
      if (this.state !== 'ready') return;

      if (!this.isRunning()) {
        launcherLog.error('Health check: CODESYS process died');
        this.lastError = 'CODESYS process died unexpectedly';
        this.pid = null;
        this.codesysPid = null;
        this.process = null;
        this.setState('error');
        this.stopHealthMonitor();
        return;
      }

      // Liveness alone cannot see the common failure: a GC-suspended
      // CODESYS keeps its PID forever. Track how long it has been
      // unresponsive and warn once it is beyond anything a normal
      // long-running operation would explain.
      const hung = this.isHung();
      if (hung === true) {
        if (hungSince === null) {
          hungSince = Date.now();
        } else if (Date.now() - hungSince >= HANG_WARN_AFTER_MS) {
          const seconds = Math.round((Date.now() - hungSince) / 1000);
          launcherLog.warn(
            `Health check: CODESYS (PID ${this.codesysPid}) has been unresponsive ` +
              `for ~${seconds}s. ${HANG_DOC_HINT}`
          );
          // Re-arm so this warns periodically rather than once.
          hungSince = Date.now();
        }
      } else if (hung === false) {
        hungSince = null;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
