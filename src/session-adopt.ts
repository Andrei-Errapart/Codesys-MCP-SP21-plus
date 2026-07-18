/**
 * Discovery, locking and GC for watcher sessions that outlive the MCP server
 * that spawned them.
 *
 * `--keep-alive` leaves a live CODESYS + watcher behind when the server
 * exits; `--adopt` lets the next server pick that session back up instead of
 * refusing to launch alongside it. This module owns everything about finding
 * such a session and claiming it safely. The launcher owns what to do with
 * one once claimed.
 *
 * Two invariants shape the design:
 *
 *   1. **Signal files are history, not liveness.** `engine.signal` records
 *      that a watcher started, not that it is still polling. The watcher can
 *      be dead while CODESYS lives (user cancelled the script, or it threw
 *      outside the main loop), and CODESYS can be GC-frozen with the watcher
 *      wedged inside it -- the hang documented in CodesysUiHang.md, which a
 *      PID liveness probe cannot see. Nothing here treats a signal file as
 *      proof; the launcher settles it with an active ping.
 *
 *   2. **A session may have at most one owner.** The transport tolerates
 *      several clients (request IDs are UUIDs and the watcher serialises
 *      execution), but the *semantics* do not: two servers would fight over
 *      which project is primary. The AsyncMutex in ipc.ts is per-process, so
 *      cross-process exclusion has to live in the filesystem -- owner.lock,
 *      acquired with an exclusive create.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { launcherLog } from './logger';

/**
 * Temp session dir prefix. Was 'codesys-mcp-persistent' under the pre-rename
 * project name; kept stable as the new project name to keep runtime
 * behaviour identical.
 */
export const SESSION_DIR_PREFIX = 'codesys-mcp-sp21-plus-ch';

/** Root under %TEMP% holding one subdirectory per session. */
export function sessionsRoot(): string {
  return path.join(os.tmpdir(), SESSION_DIR_PREFIX);
}

/** Contents of owner.lock -- the cross-process claim on a session. */
export interface OwnerLock {
  /** PID of the MCP server process holding the session. */
  ownerPid: number;
  /**
   * Owner's process start time, ISO 8601, or null if it couldn't be read.
   * PID alone is not enough: Windows recycles PIDs, and a stale lock whose
   * PID has been reused by an unrelated process would look permanently live,
   * making the session unadoptable forever.
   */
  ownerStartedIso: string | null;
  sessionId: string;
  codesysPid: number | null;
  watcherVersion: string | null;
  acquiredAt: number;
}

/** A session that looks adoptable on disk. Liveness still has to be proven. */
export interface AdoptCandidate {
  ipcDir: string;
  sessionId: string;
  /** CODESYS.exe PID as reported from inside the process by the watcher. */
  codesysPid: number;
  watcherVersion: string | null;
  /** engine.signal timestamp (epoch seconds), for newest-first ordering. */
  engineWrittenAt: number | null;
  /** Existing lock, if any. A candidate with a live lock is not adoptable. */
  lock: OwnerLock | null;
}

/** Does this PID exist? Says nothing about whether it is responsive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process start time as an ISO string, via PowerShell. Returns null when it
 * can't be determined (non-Windows, process gone, access denied) -- callers
 * must treat null as "unknown", never as "mismatch".
 */
export function processStartTime(pid: number): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const ps =
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($null -ne $p -and $null -ne $p.StartTime) { $p.StartTime.ToUniversalTime().ToString('o') }`;
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function lockPath(ipcDir: string): string {
  return path.join(ipcDir, 'owner.lock');
}

/** Read owner.lock. Returns null when absent or unparseable. */
export function readOwnerLock(ipcDir: string): OwnerLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(ipcDir), 'utf-8')) as Partial<OwnerLock>;
    if (typeof parsed.ownerPid !== 'number') return null;
    return {
      ownerPid: parsed.ownerPid,
      ownerStartedIso: typeof parsed.ownerStartedIso === 'string' ? parsed.ownerStartedIso : null,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      codesysPid: typeof parsed.codesysPid === 'number' ? parsed.codesysPid : null,
      watcherVersion: typeof parsed.watcherVersion === 'string' ? parsed.watcherVersion : null,
      acquiredAt: typeof parsed.acquiredAt === 'number' ? parsed.acquiredAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Is this lock still held by a living owner?
 *
 * A lock is stale when its PID is gone, OR when the PID is alive but belongs
 * to a *different* process than the one that took the lock -- detected by
 * comparing recorded and current start times. When either start time is
 * unknown we fall back to "PID alive means held", which errs toward refusing
 * adoption rather than double-claiming a live session.
 */
export function isLockLive(lock: OwnerLock): boolean {
  if (lock.ownerPid === process.pid) return true;
  if (!isAlive(lock.ownerPid)) return false;
  const current = processStartTime(lock.ownerPid);
  if (current === null || lock.ownerStartedIso === null) return true;
  return current === lock.ownerStartedIso;
}

/**
 * Claim a session by creating owner.lock exclusively (`wx`), which is an
 * atomic test-and-set on Windows and POSIX alike. If a lock already exists
 * but is stale, it is removed and the claim retried exactly once.
 *
 * Returns true on success. A false return means someone else holds it.
 */
export function acquireOwnerLock(
  ipcDir: string,
  lock: Omit<OwnerLock, 'ownerPid' | 'ownerStartedIso' | 'acquiredAt'>
): boolean {
  const payload: OwnerLock = {
    ...lock,
    ownerPid: process.pid,
    ownerStartedIso: processStartTime(process.pid),
    acquiredAt: Date.now(),
  };
  const body = JSON.stringify(payload, null, 2);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath(ipcDir), 'wx');
      try {
        fs.writeSync(fd, body, undefined, 'utf-8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      const existing = readOwnerLock(ipcDir);
      // Unparseable or stale -- reclaim it. A live owner means we lose.
      if (existing !== null && isLockLive(existing)) {
        return false;
      }
      launcherLog.info(
        `Reclaiming stale owner.lock in ${ipcDir} (owner PID ${existing?.ownerPid ?? 'unreadable'} is gone)`
      );
      try {
        fs.unlinkSync(lockPath(ipcDir));
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Drop our claim. Only removes the lock if we actually hold it, so a
 * late-running shutdown can never unlock a session another server has since
 * legitimately taken over.
 */
export function releaseOwnerLock(ipcDir: string): void {
  const existing = readOwnerLock(ipcDir);
  if (existing === null || existing.ownerPid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath(ipcDir));
  } catch {
    /* best effort -- a stale lock is reclaimable anyway */
  }
}

/** Parse engine.signal from a session dir. */
function readEngineSignal(
  ipcDir: string
): { pid: number | null; version: string | null; timestamp: number | null } | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(ipcDir, 'engine.signal'), 'utf-8')
    ) as { pid?: unknown; version?: unknown; timestamp?: unknown };
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : null,
    };
  } catch {
    return null;
  }
}

/**
 * Sessions whose CODESYS is still alive and whose PID is in `liveCodesysPids`
 * -- i.e. a CODESYS.exe of the *configured install*. Newest first.
 *
 * Restricting to the configured install is a trust check as much as a
 * correctness one: %TEMP% is user-writable, so a session directory is not by
 * itself evidence of anything. Requiring engine.signal's PID to match a live
 * CODESYS.exe of the exe we are configured for means we only ever inject
 * scripts into a process we would have been willing to spawn ourselves.
 *
 * Sessions carrying terminate.signal are skipped: that watcher has been told
 * to exit, so it is either already gone or about to be.
 */
export function findAdoptCandidates(liveCodesysPids: Set<number>): AdoptCandidate[] {
  const root = sessionsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const candidates: AdoptCandidate[] = [];
  for (const name of entries) {
    const ipcDir = path.join(root, name);
    try {
      if (!fs.statSync(ipcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (fs.existsSync(path.join(ipcDir, 'terminate.signal'))) continue;

    const engine = readEngineSignal(ipcDir);
    if (engine === null || engine.pid === null) continue;
    if (!liveCodesysPids.has(engine.pid)) continue;

    candidates.push({
      ipcDir,
      sessionId: name,
      codesysPid: engine.pid,
      watcherVersion: engine.version,
      engineWrittenAt: engine.timestamp,
      lock: readOwnerLock(ipcDir),
    });
  }

  candidates.sort((a, b) => (b.engineWrittenAt ?? 0) - (a.engineWrittenAt ?? 0));
  return candidates;
}

/**
 * Delete session directories whose CODESYS is gone.
 *
 * Necessary because --keep-alive deliberately stops cleaning up after itself:
 * detach() leaves the directory in place so the still-running watcher's
 * 20Hz `os.listdir(commands/)` keeps working. Once that CODESYS exits, the
 * directory is pure garbage. Directories with a live lock are never touched.
 *
 * Returns the paths removed.
 */
export function gcDeadSessions(liveCodesysPids: Set<number>, keepDir?: string | null): string[] {
  const root = sessionsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    const ipcDir = path.join(root, name);
    if (keepDir && path.resolve(ipcDir) === path.resolve(keepDir)) continue;
    try {
      if (!fs.statSync(ipcDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const lock = readOwnerLock(ipcDir);
    if (lock !== null && isLockLive(lock)) continue;

    const engine = readEngineSignal(ipcDir);
    // No engine.signal at all means the watcher never got as far as importing
    // scriptengine. That could be a launch in flight, so only sweep it once
    // it is demonstrably old.
    if (engine === null || engine.pid === null) {
      try {
        const ageMs = Date.now() - fs.statSync(ipcDir).mtimeMs;
        if (ageMs < 10 * 60 * 1000) continue;
      } catch {
        continue;
      }
    } else if (liveCodesysPids.has(engine.pid)) {
      continue;
    }

    try {
      fs.rmSync(ipcDir, { recursive: true, force: true });
      removed.push(ipcDir);
    } catch {
      /* locked by something; try again next start */
    }
  }
  return removed;
}
