import { spawn } from 'child_process';
import { ENV_KEYS, validateSshHost, validateSshUser } from './ssh-restart-runtime';

/**
 * Read the running PLC's project version over SSH, bypassing the CODESYS
 * IDE entirely.
 *
 * WHY: read_running_version_online needs CODESYS open + the .project file
 * unlocked + the device-online protocol reachable. When any of those is
 * absent (project file held by another CODESYS instance, no CODESYS
 * install on this machine, online protocol blocked), the only remaining
 * path to the running version is the boot-application binary on disk on
 * the PLC itself. The X.Y.Z.W literal of `_MCP_PROJECT_VERSION.sVersion`
 * is baked into that binary by the compiler -- `strings` extracts it.
 *
 * The CODESYS V3.5 SP-runtime version (e.g. 3.5.22.0) is also baked in
 * by the same toolchain; we filter `3.5.*` out so the caller gets just
 * the project-version literal.
 *
 * Implementation choices:
 *   - Spawn the system `ssh` binary instead of pulling in `ssh2` /
 *     `node-ssh` -- zero new npm deps and the user already has ssh
 *     keys configured for the PLC anyway.
 *   - `BatchMode=yes` so the call fails fast when keys aren't installed
 *     instead of hanging on a password prompt.
 *   - `sudo -n` for the same reason -- non-interactive; clear failure
 *     when NOPASSWD sudo isn't configured for `strings`.
 */

export interface SshVersionResult {
  host: string;
  user: string;
  bootAppPath: string;
  projectVersion: string | null;
  candidates: string[];
  runtimeVersionLiterals: string[];
}

export interface SshVersionOptions {
  host: string;
  user?: string;
  bootAppPath?: string;
}

const DEFAULT_BOOT_APP_PATH = '/var/opt/codesys/PlcLogic/Application/Application.app';

/** Overall deadline for the ssh round trip. ConnectTimeout only bounds the handshake. */
const SSH_TIMEOUT_MS = 60_000;

const VERSION_LITERAL_RE = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Absolute POSIX path, no shell metacharacters, no parent traversal.
 * This value is interpolated into a command string that the REMOTE login
 * shell parses, so quoting on this side would not be sufficient -- a
 * value like `/x; rm -rf /var/opt/codesys` has to be rejected outright.
 */
const BOOT_APP_PATH_RE = /^\/[A-Za-z0-9._\-/]{0,255}$/;

export function validateBootAppPath(bootAppPath: string): string {
  if (!BOOT_APP_PATH_RE.test(bootAppPath) || bootAppPath.includes('..')) {
    throw new Error(
      `Refusing to use bootAppPath '${bootAppPath}': it must be an absolute POSIX ` +
        `path matching ${BOOT_APP_PATH_RE} with no '..' segments. The path is ` +
        `interpolated into a remote sudo command, so shell metacharacters are ` +
        `rejected outright.`
    );
  }
  return bootAppPath;
}

/**
 * Pure parser, factored out so unit tests can exercise the filter logic
 * without spawning ssh. Splits stdout on newlines, trims, drops blanks
 * and non-X.Y.Z.W tokens, separates 3.5.* (CODESYS SP-runtime) from
 * everything else, and decides whether a unique project-version
 * candidate emerged.
 */
export function parseSshOutput(stdout: string): {
  candidates: string[];
  projectVersion: string | null;
  runtimeVersionLiterals: string[];
} {
  const literals = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => VERSION_LITERAL_RE.test(l));

  const runtimeVersionLiterals: string[] = [];
  const candidates: string[] = [];
  for (const lit of literals) {
    if (lit.startsWith('3.5.')) {
      runtimeVersionLiterals.push(lit);
    } else {
      candidates.push(lit);
    }
  }

  let projectVersion: string | null = null;
  if (candidates.length === 1) {
    projectVersion = candidates[0];
  }
  return { candidates, projectVersion, runtimeVersionLiterals };
}

/**
 * Spawn `ssh` and run a command; capture stdout/stderr/exit-code.
 * Wrapped in a Promise so the caller can await it.
 */
function runSsh(
  user: string,
  host: string,
  remoteCommand: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${user}@${host}`,
      remoteCommand,
    ];
    let child;
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;

    // ConnectTimeout bounds only the handshake. A host that connects and
    // then stalls (huge .app on a slow disk, wedged NFS mount) would
    // otherwise leave this promise pending forever and the MCP tool call
    // would never return.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `ssh to ${host} timed out after ${SSH_TIMEOUT_MS}ms. ` +
            `Partial stderr: ${stderr.trim().slice(0, 500)}`
        )
      );
    }, SSH_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function buildKeyAuthErrorMessage(user: string, host: string): string {
  return (
    `SSH key auth failed for ${user}@${host}.\n\n` +
    `This tool requires SSH key authentication (no password support).\n\n` +
    `To install your key (one-time setup, paste in PowerShell):\n\n` +
    `  Get-Content $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh -o StrictHostKeyChecking=accept-new ${user}@${host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo 'KEY INSTALLED'"\n\n` +
    `If the host key changed (e.g., the device was reflashed), wipe the stale entry first:\n\n` +
    `  ssh-keygen -R ${host}\n\n` +
    `Verify with:\n\n` +
    `  ssh ${user}@${host} "echo OK"\n\n` +
    `Full doc: https://gitlab.usv.no/karstein.kvistad/mr-ai-context/-/blob/main/ssh-key-windows.md`
  );
}

function buildSudoErrorMessage(user: string, host: string): string {
  return (
    `sudo on ${host} requires a password (we run with sudo -n / non-interactive).\n\n` +
    `Configure passwordless sudo for the boot-app read by adding this line via 'sudo visudo' on the PLC:\n\n` +
    `  ${user} ALL=(ALL) NOPASSWD: /usr/bin/strings, /usr/bin/find, /usr/bin/cat\n\n` +
    `Or, less restrictive but simpler:\n\n` +
    `  ${user} ALL=(ALL) NOPASSWD: ALL`
  );
}

function buildEmptyOutputErrorMessage(
  user: string,
  host: string,
  bootAppPath: string
): string {
  return (
    `No version literals found in ${bootAppPath} on ${host}.\n\n` +
    `Either:\n` +
    `- No project has been downloaded to this PLC yet, or\n` +
    `- The boot application is at a non-standard path. Confirm with:\n` +
    `  ssh ${user}@${host} "sudo find / -maxdepth 6 -name '*.app' 2>/dev/null"`
  );
}

export async function readRunningVersionSsh(
  opts: SshVersionOptions
): Promise<SshVersionResult> {
  if (!opts.host || !opts.host.trim()) {
    throw new Error('readRunningVersionSsh: host is required');
  }
  const host = validateSshHost(opts.host.trim());

  // No baked-in username -- see the ssh-restart-runtime header for why.
  const rawUser = opts.user ?? process.env[ENV_KEYS.user];
  if (!rawUser) {
    throw new Error(
      `Missing SSH user. Pass it explicitly or set ${ENV_KEYS.user}. ` +
        `This tool ships no default credentials.`
    );
  }
  const user = validateSshUser(rawUser);
  const bootAppPath = validateBootAppPath(opts.bootAppPath ?? DEFAULT_BOOT_APP_PATH);

  // The remote pipeline: dump printable strings from the boot app, keep
  // only X.Y.Z.W tokens, dedupe. We still parse + filter on the client
  // side (parseSshOutput) so the helper is testable and so a misbehaving
  // remote (e.g. extra log noise leaking onto stdout) is tolerated.
  const remoteCommand =
    `sudo -n strings ${bootAppPath} | grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -u`;

  const { stdout, stderr, code } = await runSsh(user, host, remoteCommand);

  const stderrLower = stderr.toLowerCase();

  // Order matters: check the named failure modes first so the caller gets
  // the exact-instructions message, then fall back to raw-stderr for any
  // other non-zero exit.
  if (
    stderrLower.includes('permission denied (publickey)') ||
    stderrLower.includes('permission denied (publickey,')
  ) {
    throw new Error(buildKeyAuthErrorMessage(user, host));
  }
  if (
    stderrLower.includes('a password is required') ||
    stderrLower.includes('a terminal is required') ||
    stderrLower.includes('no tty present and no askpass program specified')
  ) {
    throw new Error(buildSudoErrorMessage(user, host));
  }

  if (code !== 0) {
    // grep returns exit code 1 when no lines match -- that's not a real
    // error, it just means the boot app had no X.Y.Z.W literals at all.
    // Treat that as "empty stdout" below; surface a clear message.
    if (code === 1 && stdout.trim().length === 0 && stderr.trim().length === 0) {
      throw new Error(buildEmptyOutputErrorMessage(user, host, bootAppPath));
    }
    throw new Error(
      stderr.trim().length > 0
        ? stderr.trim()
        : `ssh exited with code ${code} (no stderr)`
    );
  }

  if (stdout.trim().length === 0) {
    throw new Error(buildEmptyOutputErrorMessage(user, host, bootAppPath));
  }

  const parsed = parseSshOutput(stdout);
  return {
    host,
    user,
    bootAppPath,
    projectVersion: parsed.projectVersion,
    candidates: parsed.candidates,
    runtimeVersionLiterals: parsed.runtimeVersionLiterals,
  };
}

/**
 * Format a SshVersionResult for human-readable output (CLI + MCP tool).
 * Shared so both surfaces emit identical text.
 */
export function formatSshVersionResult(res: SshVersionResult): string {
  const lines: string[] = [];
  lines.push(`Host: ${res.host} (${res.user}@)`);
  lines.push(`Boot app: ${res.bootAppPath}`);
  lines.push(`Project version: ${res.projectVersion ?? '(not found)'}`);
  if (res.candidates.length > 1) {
    lines.push(`Ambiguous candidates: ${res.candidates.join(', ')}`);
  }
  lines.push(
    `CODESYS runtime literals filtered: ${
      res.runtimeVersionLiterals.length > 0
        ? res.runtimeVersionLiterals.join(', ')
        : '(none)'
    }`
  );
  return lines.join('\n');
}
