import { Client } from 'ssh2';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Restart the CODESYS Control runtime on a Linux PLC over SSH using
 * password auth and password-fed `sudo -S`.
 *
 * WHY THIS EXISTS: an unlicensed CODESYS Control runtime (Raspberry Pi
 * etc.) drops out of demo mode every 2 hours -- systemctl still reports
 * the service as "active" even though the binary has died, so a port
 * check on 11740 is the real liveness signal. This tool gives the MCP a
 * one-call path to bring it back without dropping into a terminal.
 *
 * WHY ssh2 (not spawned `ssh`/`sshpass`):
 *   - sshpass is not available on Windows by default.
 *   - The target Pi's sshd 10.x rejects pubkey signatures from this
 *     environment in practice; password auth is the documented working
 *     path.
 *   - ssh2 is pure JS, runs the same on Windows / macOS / Linux, and
 *     handles password auth + remote stdin + exit-code capture cleanly.
 *
 * NO CREDENTIALS ARE BAKED IN. Host/user/password must come from the
 * caller or from CODESYS_PLC_* environment variables. An earlier version
 * of this file shipped a working host, username and password as literal
 * defaults, which meant they were published in the npm tarball and echoed
 * into the MCP tool schema on every session. Do not reintroduce them:
 * anything in DEFAULTS below is, by definition, public.
 */

/** Environment variables consulted when an option is omitted. */
export const ENV_KEYS = {
  host: 'CODESYS_PLC_HOST',
  port: 'CODESYS_PLC_PORT',
  user: 'CODESYS_PLC_USER',
  password: 'CODESYS_PLC_PASSWORD',
  sudoPassword: 'CODESYS_PLC_SUDO_PASSWORD',
  hostKeyPolicy: 'CODESYS_PLC_HOSTKEY_POLICY',
} as const;

export interface RestartRuntimeOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  sudoPassword?: string;
  service?: string;
  /** Seconds to wait for socket-listening on portCheck after restart. 0 = skip liveness check. */
  livenessWaitSeconds?: number;
  /** TCP port to probe for liveness after restart. Defaults to 11740 (CODESYS gateway). */
  livenessPort?: number;
  /** Connection timeout for the SSH handshake itself, ms. */
  connectTimeoutMs?: number;
  /**
   * Expected host key fingerprint, OpenSSH style (`SHA256:<base64>`).
   * When supplied, the key must match exactly -- no trust-on-first-use.
   */
  hostKeyFingerprint?: string;
  /**
   * How to treat an unknown host key:
   *   'tofu'     (default) accept on first contact, pin it, refuse changes
   *   'strict'   refuse unless already pinned or hostKeyFingerprint matches
   *   'insecure' accept anything (never use outside an isolated lab)
   */
  hostKeyPolicy?: HostKeyPolicy;
}

export type HostKeyPolicy = 'tofu' | 'strict' | 'insecure';

export interface RestartRuntimeResult {
  host: string;
  user: string;
  service: string;
  /** Exit code from `sudo -S systemctl restart`. 0 = restart issued cleanly. */
  restartExitCode: number;
  restartStdout: string;
  restartStderr: string;
  /** True if the runtime was confirmed listening on livenessPort after restart. null if liveness skipped. */
  listening: boolean | null;
  /** Seconds we waited before the liveness probe succeeded (or gave up). */
  livenessElapsedSeconds: number;
  /** Output of the post-restart `ss -tln | grep <port>` probe (empty if not listening). */
  livenessProbeOutput: string;
  /** Fingerprint of the host key we actually talked to, for the audit trail. */
  hostKeyFingerprint: string;
}

/**
 * Non-secret defaults only. Host, user and passwords are deliberately
 * absent -- see the file header.
 */
const DEFAULTS = {
  port: 22,
  service: 'codesyscontrol',
  livenessWaitSeconds: 30,
  livenessPort: 11740,
  connectTimeoutMs: 15000,
  hostKeyPolicy: 'tofu' as HostKeyPolicy,
};

// ─── Input validation ────────────────────────────────────────────────
//
// Everything below is interpolated into a command string that the REMOTE
// login shell parses. Quoting on this side is not enough -- the only safe
// approach is to reject anything that isn't shell-inert.

/** systemd unit names: letters, digits and `-_.@:\` plus an optional suffix. */
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
/** POSIX usernames. Must not start with `-` or ssh parses it as an option. */
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Hostname, IPv4, or IPv6-in-brackets. Must not start with `-`. */
const SSH_HOST_RE = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9._-]{0,253})$/;

export function validateServiceName(service: string): string {
  if (!SERVICE_RE.test(service)) {
    throw new Error(
      `Refusing to use service name '${service}': it must match ${SERVICE_RE} ` +
        `(letters, digits, and . _ @ : -). The name is interpolated into a remote ` +
        `sudo command, so shell metacharacters are rejected outright.`
    );
  }
  return service;
}

export function validateSshUser(user: string): string {
  if (!SSH_USER_RE.test(user)) {
    throw new Error(
      `Refusing to use SSH user '${user}': it must match ${SSH_USER_RE}. ` +
        `Values starting with '-' are rejected because they are parsed as ssh options.`
    );
  }
  return user;
}

export function validateSshHost(host: string): string {
  if (!SSH_HOST_RE.test(host)) {
    throw new Error(
      `Refusing to use SSH host '${host}': it must match ${SSH_HOST_RE}. ` +
        `Values starting with '-' are rejected because they are parsed as ssh options.`
    );
  }
  return host;
}

export function validatePort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Refusing to use ${label} '${port}': must be an integer in 1..65535.`);
  }
  return port;
}

// ─── Host key verification ───────────────────────────────────────────

/** OpenSSH-style `SHA256:<unpadded base64>` fingerprint of a raw key blob. */
export function fingerprintHostKey(key: Buffer): string {
  const digest = crypto.createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function knownHostsPath(): string {
  return path.join(os.homedir(), '.codesys-mcp', 'known_hosts');
}

/** Read the pinned fingerprint for `host:port`, or null if not pinned. */
export function readPinnedFingerprint(hostPort: string, filePath = knownHostsPath()): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [entry, fingerprint] = trimmed.split(/\s+/, 2);
      if (entry === hostPort && fingerprint) return fingerprint;
    }
  } catch {
    // No known_hosts yet -- first contact.
  }
  return null;
}

/** Pin `fingerprint` for `host:port`, creating the store if needed. */
export function pinFingerprint(
  hostPort: string,
  fingerprint: string,
  filePath = knownHostsPath()
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${hostPort} ${fingerprint}\n`, { mode: 0o600 });
}

/**
 * Decide whether to accept a host key. Exported so the policy is unit
 * testable without standing up an SSH server.
 */
export function verifyHostKey(args: {
  hostPort: string;
  fingerprint: string;
  policy: HostKeyPolicy;
  expected?: string;
  pinned: string | null;
}): { accept: boolean; pin: boolean; reason: string } {
  const { hostPort, fingerprint, policy, expected, pinned } = args;

  if (policy === 'insecure') {
    return { accept: true, pin: false, reason: 'hostKeyPolicy=insecure -- key not verified' };
  }

  // An explicit expected fingerprint always wins, in both directions.
  if (expected) {
    return expected === fingerprint
      ? { accept: true, pin: false, reason: 'matched hostKeyFingerprint' }
      : {
          accept: false,
          pin: false,
          reason:
            `host key mismatch for ${hostPort}: expected ${expected}, got ${fingerprint}. ` +
            `Refusing to connect.`,
        };
  }

  if (pinned) {
    return pinned === fingerprint
      ? { accept: true, pin: false, reason: 'matched pinned key' }
      : {
          accept: false,
          pin: false,
          reason:
            `HOST KEY CHANGED for ${hostPort}: pinned ${pinned}, got ${fingerprint}. ` +
            `This is either a reflashed device or a machine-in-the-middle. ` +
            `If the device was legitimately reimaged, remove its line from ` +
            `${knownHostsPath()} and retry.`,
        };
  }

  if (policy === 'strict') {
    return {
      accept: false,
      pin: false,
      reason:
        `no pinned host key for ${hostPort} and hostKeyPolicy=strict. ` +
        `Pass hostKeyFingerprint=${fingerprint} if that is the key you expect.`,
    };
  }

  return { accept: true, pin: true, reason: `trust-on-first-use: pinned ${fingerprint}` };
}

/**
 * Run a single SSH command using password auth. Returns stdout/stderr/exit code.
 * If `stdinPayload` is provided, it's written to the remote stdin (used for `sudo -S`).
 */
function runOnce(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  command: string;
  stdinPayload?: string;
  connectTimeoutMs: number;
  hostKeyPolicy: HostKeyPolicy;
  hostKeyFingerprint?: string;
  onHostKey?: (fingerprint: string) => void;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    // Guards every terminal path. Without it a handshake that completes
    // just after the deadline still runs the command -- which for a
    // `systemctl restart` means a second, unrequested outage on a PLC the
    // caller was already told we failed to reach.
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        // ignore
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `SSH connect/exec timed out after ${opts.connectTimeoutMs}ms ` +
              `(${opts.user}@${opts.host}:${opts.port})`
          )
        )
      );
    }, opts.connectTimeoutMs);

    conn.on('ready', () => {
      if (settled) return;
      conn.exec(opts.command, (err, stream) => {
        if (err) {
          finish(() => reject(err));
          return;
        }
        stream
          .on('close', (code: number | null) => {
            finish(() => resolve({ stdout, stderr, code }));
          })
          .on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        if (opts.stdinPayload !== undefined) {
          stream.stdin.write(opts.stdinPayload);
        }
        stream.stdin.end();
      });
    });

    conn.on('error', (err) => {
      // conn.end() inside finish() -- the previous version left the
      // Client un-torn-down on every auth failure.
      finish(() => reject(err));
    });

    const hostPort = `${opts.host}:${opts.port}`;

    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.user,
      password: opts.password,
      readyTimeout: opts.connectTimeoutMs,
      // The Pi's sshd 10.x advertises pubkey but rejects signatures from
      // this client in practice. Forcing password auth avoids a slow
      // failed-pubkey roundtrip on every connect.
      authHandler: ['password'],
      // Without this, ssh2 accepts ANY host key. Password auth against an
      // unverified key hands the password (and, via `sudo -S`, the sudo
      // password) to whoever answered -- and the usual target is an mDNS
      // name, which is trivially spoofable on a flat plant network.
      hostVerifier: (key: Buffer): boolean => {
        const fingerprint = fingerprintHostKey(key);
        opts.onHostKey?.(fingerprint);
        const verdict = verifyHostKey({
          hostPort,
          fingerprint,
          policy: opts.hostKeyPolicy,
          expected: opts.hostKeyFingerprint,
          pinned: readPinnedFingerprint(hostPort),
        });
        if (verdict.accept && verdict.pin) {
          try {
            pinFingerprint(hostPort, fingerprint);
          } catch {
            // A read-only home directory shouldn't break the connection;
            // it just means we re-TOFU next time.
          }
        }
        if (!verdict.accept) {
          // ssh2 surfaces a rejected key as a generic handshake failure,
          // so attach the real reason to the error path ourselves.
          finish(() => reject(new Error(`SSH host key rejected -- ${verdict.reason}`)));
        }
        return verdict.accept;
      },
    } as never);
  });
}

/** Resolve a required credential from options, then env, else throw. */
function requireCredential(
  value: string | undefined,
  envKey: string,
  label: string
): string {
  const resolved = value ?? process.env[envKey];
  if (!resolved) {
    throw new Error(
      `Missing ${label}. Pass it explicitly or set ${envKey}. ` +
        `This tool ships no default credentials.`
    );
  }
  return resolved;
}

export async function restartCodesysRuntime(
  options: RestartRuntimeOptions = {}
): Promise<RestartRuntimeResult> {
  const host = validateSshHost(requireCredential(options.host, ENV_KEYS.host, 'PLC host'));
  const envPort = process.env[ENV_KEYS.port];
  const port = validatePort(
    options.port ?? (envPort ? Number(envPort) : DEFAULTS.port),
    'SSH port'
  );
  const user = validateSshUser(requireCredential(options.user, ENV_KEYS.user, 'SSH user'));
  const password = requireCredential(options.password, ENV_KEYS.password, 'SSH password');
  const sudoPassword =
    options.sudoPassword ?? process.env[ENV_KEYS.sudoPassword] ?? password;
  const service = validateServiceName(options.service ?? DEFAULTS.service);
  const livenessWaitSeconds = options.livenessWaitSeconds ?? DEFAULTS.livenessWaitSeconds;
  const livenessPort = validatePort(
    options.livenessPort ?? DEFAULTS.livenessPort,
    'liveness port'
  );
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const hostKeyPolicy =
    options.hostKeyPolicy ??
    (process.env[ENV_KEYS.hostKeyPolicy] as HostKeyPolicy | undefined) ??
    DEFAULTS.hostKeyPolicy;

  let observedFingerprint = '';
  const onHostKey = (fp: string) => {
    observedFingerprint = fp;
  };
  const connBase = {
    host,
    port,
    user,
    password,
    connectTimeoutMs,
    hostKeyPolicy,
    hostKeyFingerprint: options.hostKeyFingerprint,
    onHostKey,
  };

  // The restart itself. `sudo -S` reads the password from stdin so we
  // don't need a tty / sudoers NOPASSWD entry. `service` is charset
  // validated above, so it cannot break out of the command.
  const restartRes = await runOnce({
    ...connBase,
    command: `sudo -S systemctl restart ${service}`,
    stdinPayload: `${sudoPassword}\n`,
  });

  // `systemctl is-active` lies on this Pi -- it reports "active" even
  // after the binary has died from license expiry. The real liveness
  // signal is whether port 11740 is listening, so probe that until it
  // comes up or we time out.
  let listening: boolean | null = null;
  let livenessElapsedSeconds = 0;
  let livenessProbeOutput = '';
  if (livenessWaitSeconds > 0) {
    const startedAt = Date.now();
    const deadline = startedAt + livenessWaitSeconds * 1000;
    const probeCmd = `ss -tln | grep ':${livenessPort}\\b' || true`;
    while (Date.now() < deadline) {
      const probe = await runOnce({ ...connBase, command: probeCmd });
      if (probe.code === 0 && probe.stdout.includes(`:${livenessPort}`)) {
        listening = true;
        livenessProbeOutput = probe.stdout.trim();
        break;
      }
      livenessProbeOutput = probe.stdout.trim();
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Measure from the actual start, not from the deadline arithmetic --
    // the old form always reported the full window even on a fast success.
    livenessElapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (listening === null) {
      listening = false;
    }
  }

  return {
    host,
    user,
    service,
    restartExitCode: restartRes.code ?? -1,
    restartStdout: restartRes.stdout,
    restartStderr: restartRes.stderr,
    listening,
    livenessElapsedSeconds,
    livenessProbeOutput,
    hostKeyFingerprint: observedFingerprint,
  };
}

export function formatRestartRuntimeResult(res: RestartRuntimeResult): string {
  const lines: string[] = [];
  lines.push(`Host: ${res.host} (${res.user}@)`);
  lines.push(`Service: ${res.service}`);
  if (res.hostKeyFingerprint) {
    lines.push(`Host key: ${res.hostKeyFingerprint}`);
  }
  lines.push(
    `systemctl restart exit code: ${res.restartExitCode}` +
      (res.restartExitCode === 0 ? ' (clean)' : ' (FAILED)')
  );
  if (res.restartStderr.trim().length > 0) {
    // sudo banners about password reading land on stderr -- include
    // them so the user can spot real errors vs. cosmetic noise.
    lines.push(`  stderr: ${res.restartStderr.trim()}`);
  }
  if (res.listening === null) {
    lines.push('Liveness probe: skipped');
  } else if (res.listening) {
    lines.push(`Listening on the runtime port: YES (after ~${res.livenessElapsedSeconds}s)`);
    if (res.livenessProbeOutput) {
      lines.push(`  ${res.livenessProbeOutput}`);
    }
  } else {
    lines.push(
      `Listening on the runtime port: NO after ${res.livenessElapsedSeconds}s -- ` +
        `the runtime did NOT come back up. Check the ${res.service} log on the PLC.`
    );
  }
  return lines.join('\n');
}
