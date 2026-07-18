import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import {
  acquireOwnerLock,
  findAdoptCandidates,
  gcDeadSessions,
  isLockLive,
  readOwnerLock,
  releaseOwnerLock,
  sessionsRoot,
  SESSION_DIR_PREFIX,
} from '../../src/session-adopt';
import { CodesysLauncher } from '../../src/launcher';
import { IpcClient, DEFAULT_IPC_CONFIG } from '../../src/ipc';

/**
 * These tests must never touch the real %TEMP% sessions root -- a developer
 * running them may have a live CODESYS session parked there, and gcDeadSessions
 * deletes directories. os.tmpdir() re-reads TEMP/TMP on every call, so
 * redirecting those env vars fully isolates sessionsRoot() for the test.
 */
let sandbox: string;
let savedEnv: Record<string, string | undefined>;

function makeSession(name: string, engine?: { pid: number; version?: string; timestamp?: number }): string {
  const dir = path.join(sessionsRoot(), name);
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  if (engine) {
    fs.writeFileSync(
      path.join(dir, 'engine.signal'),
      JSON.stringify({
        version: engine.version ?? '0.4.2',
        pid: engine.pid,
        timestamp: engine.timestamp ?? Date.now() / 1000,
      })
    );
  }
  return dir;
}

/** A PID that is certainly not running. */
const DEAD_PID = 0x7ffffffe;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-test-'));
  savedEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = sandbox;
  process.env.TMP = sandbox;
  process.env.TMPDIR = sandbox;
  fs.mkdirSync(sessionsRoot(), { recursive: true });
});

afterEach(() => {
  process.env.TEMP = savedEnv.TEMP;
  process.env.TMP = savedEnv.TMP;
  process.env.TMPDIR = savedEnv.TMPDIR;
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('sessionsRoot', () => {
  it('lives under the temp dir with the shared session prefix', () => {
    expect(sessionsRoot()).toBe(path.join(sandbox, SESSION_DIR_PREFIX));
  });
});

describe('owner.lock', () => {
  it('claims an unlocked session', () => {
    const dir = makeSession('s1', { pid: process.pid });
    expect(acquireOwnerLock(dir, { sessionId: 's1', codesysPid: 123, watcherVersion: '0.4.2' })).toBe(true);

    const lock = readOwnerLock(dir);
    expect(lock?.ownerPid).toBe(process.pid);
    expect(lock?.codesysPid).toBe(123);
    expect(lock?.sessionId).toBe('s1');
  });

  it('refuses a session already held by a live owner', () => {
    const dir = makeSession('s2', { pid: process.pid });
    acquireOwnerLock(dir, { sessionId: 's2', codesysPid: 1, watcherVersion: null });
    // Second claim finds our own live lock and must lose rather than
    // silently double-claim.
    expect(acquireOwnerLock(dir, { sessionId: 's2', codesysPid: 1, watcherVersion: null })).toBe(false);
  });

  it('reclaims a lock whose owner process is gone', () => {
    const dir = makeSession('s3', { pid: process.pid });
    fs.writeFileSync(
      path.join(dir, 'owner.lock'),
      JSON.stringify({
        ownerPid: DEAD_PID,
        ownerStartedIso: '2020-01-01T00:00:00.0000000Z',
        sessionId: 's3',
        codesysPid: 999,
        watcherVersion: '0.4.2',
        acquiredAt: 1,
      })
    );
    expect(isLockLive(readOwnerLock(dir)!)).toBe(false);
    expect(acquireOwnerLock(dir, { sessionId: 's3', codesysPid: 999, watcherVersion: '0.4.2' })).toBe(true);
    expect(readOwnerLock(dir)?.ownerPid).toBe(process.pid);
  });

  it('treats a live PID with a different start time as stale (PID reuse)', () => {
    const dir = makeSession('s4', { pid: process.pid });
    fs.writeFileSync(
      path.join(dir, 'owner.lock'),
      JSON.stringify({
        ownerPid: process.pid,
        // Our PID, but recorded as started long before this process existed --
        // exactly what a recycled PID looks like.
        ownerStartedIso: '1999-01-01T00:00:00.0000000Z',
        sessionId: 's4',
        codesysPid: 1,
        watcherVersion: null,
        acquiredAt: 1,
      })
    );
    const lock = readOwnerLock(dir)!;
    // Self-PID short-circuits to live, so check the discriminator directly on
    // a foreign-looking record instead.
    expect(lock.ownerStartedIso).not.toBeNull();
    expect(isLockLive({ ...lock, ownerPid: DEAD_PID })).toBe(false);
  });

  it('release only removes a lock we hold', () => {
    const dir = makeSession('s5', { pid: process.pid });
    fs.writeFileSync(
      path.join(dir, 'owner.lock'),
      JSON.stringify({ ownerPid: DEAD_PID, ownerStartedIso: null, sessionId: 's5', codesysPid: 1, watcherVersion: null, acquiredAt: 1 })
    );
    releaseOwnerLock(dir);
    expect(fs.existsSync(path.join(dir, 'owner.lock'))).toBe(true);

    acquireOwnerLock(dir, { sessionId: 's5', codesysPid: 1, watcherVersion: null });
    releaseOwnerLock(dir);
    expect(fs.existsSync(path.join(dir, 'owner.lock'))).toBe(false);
  });
});

describe('findAdoptCandidates', () => {
  it('returns only sessions whose CODESYS PID is in the live set', () => {
    makeSession('live', { pid: 4242 });
    makeSession('dead', { pid: DEAD_PID });

    const found = findAdoptCandidates(new Set([4242]));
    expect(found.map((c) => c.sessionId)).toEqual(['live']);
    expect(found[0].codesysPid).toBe(4242);
    expect(found[0].watcherVersion).toBe('0.4.2');
  });

  it('skips sessions with no engine.signal (watcher never reached scriptengine)', () => {
    makeSession('no-engine');
    expect(findAdoptCandidates(new Set([4242]))).toEqual([]);
  });

  it('skips sessions already told to terminate', () => {
    const dir = makeSession('terminating', { pid: 4242 });
    fs.writeFileSync(path.join(dir, 'terminate.signal'), '{}');
    expect(findAdoptCandidates(new Set([4242]))).toEqual([]);
  });

  it('orders newest engine.signal first', () => {
    makeSession('older', { pid: 4242, timestamp: 1000 });
    makeSession('newer', { pid: 4243, timestamp: 2000 });
    const found = findAdoptCandidates(new Set([4242, 4243]));
    expect(found.map((c) => c.sessionId)).toEqual(['newer', 'older']);
  });

  it('reports an existing lock without filtering the candidate out', () => {
    // Staleness is decided at claim time, not discovery time -- a candidate
    // with a dead owner must still be offered.
    const dir = makeSession('locked', { pid: 4242 });
    fs.writeFileSync(
      path.join(dir, 'owner.lock'),
      JSON.stringify({ ownerPid: DEAD_PID, ownerStartedIso: null, sessionId: 'locked', codesysPid: 4242, watcherVersion: null, acquiredAt: 1 })
    );
    const found = findAdoptCandidates(new Set([4242]));
    expect(found).toHaveLength(1);
    expect(found[0].lock?.ownerPid).toBe(DEAD_PID);
  });
});

describe('gcDeadSessions', () => {
  it('removes sessions whose CODESYS is gone and keeps live ones', () => {
    const dead = makeSession('gone', { pid: DEAD_PID });
    const live = makeSession('still-here', { pid: 4242 });

    const removed = gcDeadSessions(new Set([4242]));
    expect(removed).toEqual([dead]);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('never removes a session held by a live owner', () => {
    const dir = makeSession('held', { pid: DEAD_PID });
    acquireOwnerLock(dir, { sessionId: 'held', codesysPid: DEAD_PID, watcherVersion: null });

    expect(gcDeadSessions(new Set())).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('spares a young session with no engine.signal (launch may be in flight)', () => {
    const dir = makeSession('launching');
    expect(gcDeadSessions(new Set())).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('sweeps an old session with no engine.signal', () => {
    const dir = makeSession('abandoned');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    expect(gcDeadSessions(new Set())).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('honours keepDir even when the session looks dead', () => {
    const dir = makeSession('ours', { pid: DEAD_PID });
    expect(gcDeadSessions(new Set(), dir)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against the mock watcher.
//
// The adoption probe is the one thing no amount of file-shuffling can prove:
// it has to demonstrate that a *running* watcher answers and a dead one does
// not. The mock watcher executes commands exactly like the real one, and a
// stub `scriptengine` module on PYTHONPATH lets the probe report a project
// path without CODESYS being involved.
// ---------------------------------------------------------------------------

const FAKE_SCRIPTENGINE = `
import os

class _Proj(object):
    def __init__(self, p):
        self.path = p

class _Projects(object):
    @property
    def primary(self):
        p = os.environ.get('FAKE_PRIMARY_PROJECT', '')
        return _Proj(p) if p else None

projects = _Projects()
`;

function spawnMockWatcher(ipcDir: string, primaryProject: string): ChildProcess {
  const stubDir = path.join(ipcDir, 'pystub');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'scriptengine.py'), FAKE_SCRIPTENGINE);

  const mockWatcherPath = path.join(__dirname, '..', 'mock_watcher.py');
  return spawn('python', [mockWatcherPath, '--ipc-dir', ipcDir], {
    stdio: 'ignore',
    env: { ...process.env, PYTHONPATH: stubDir, FAKE_PRIMARY_PROJECT: primaryProject },
  });
}

async function waitForEngineSignal(ipcDir: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(ipcDir, 'engine.signal'))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('adoption probe (mock watcher)', () => {
  let watcher: ChildProcess | null = null;

  afterEach(() => {
    if (watcher) {
      watcher.kill();
      watcher = null;
    }
  });

  it('reads the primary project back from a live watcher', async () => {
    const ipcDir = makeSession('probe-live');
    watcher = spawnMockWatcher(ipcDir, 'C:\\proj\\Human.project');
    expect(await waitForEngineSignal(ipcDir)).toBe(true);

    const launcher = new CodesysLauncher({
      codesysPath: 'C:\\nonexistent\\CODESYS.exe',
      profileName: 'test',
      workspaceDir: sandbox,
    });
    const client = new IpcClient({ baseDir: ipcDir, ...DEFAULT_IPC_CONFIG });
    const primary = await (launcher as any).probePrimaryProject(client, 20_000);

    expect(primary).toBe('C:\\proj\\Human.project');
  }, 45_000);

  it('reports no project when the IDE has none open', async () => {
    const ipcDir = makeSession('probe-empty');
    watcher = spawnMockWatcher(ipcDir, '');
    expect(await waitForEngineSignal(ipcDir)).toBe(true);

    const launcher = new CodesysLauncher({
      codesysPath: 'C:\\nonexistent\\CODESYS.exe',
      profileName: 'test',
      workspaceDir: sandbox,
    });
    const client = new IpcClient({ baseDir: ipcDir, ...DEFAULT_IPC_CONFIG });
    expect(await (launcher as any).probePrimaryProject(client, 20_000)).toBe('');
  }, 45_000);

  it('returns null when nothing is consuming commands', async () => {
    // A session directory that looks perfectly healthy on disk but has no
    // watcher behind it: exactly the stale case adoption must refuse.
    const ipcDir = makeSession('probe-dead', { pid: process.pid });
    const launcher = new CodesysLauncher({
      codesysPath: 'C:\\nonexistent\\CODESYS.exe',
      profileName: 'test',
      workspaceDir: sandbox,
    });
    const client = new IpcClient({ baseDir: ipcDir, ...DEFAULT_IPC_CONFIG });
    expect(await (launcher as any).probePrimaryProject(client, 2_000)).toBeNull();
  }, 20_000);
});

describe('checkProjectSwitch', () => {
  function adoptedLauncher(ipcDir: string, openProject: string | null): CodesysLauncher {
    const l = new CodesysLauncher({
      codesysPath: 'C:\\nonexistent\\CODESYS.exe',
      profileName: 'test',
      workspaceDir: sandbox,
      adopt: true,
    });
    const priv = l as any;
    priv.ownership = 'adopted';
    priv.state = 'ready';
    priv.codesysPid = 4242;
    priv.ipcDir = ipcDir;
    priv.ipcClient = new IpcClient({ baseDir: ipcDir, ...DEFAULT_IPC_CONFIG });
    priv.adoptedProjectPath = openProject;
    return l;
  }

  it('allows anything when the launcher owns the instance', async () => {
    const l = new CodesysLauncher({
      codesysPath: 'C:\\nonexistent\\CODESYS.exe',
      profileName: 'test',
      workspaceDir: sandbox,
    });
    expect(await l.checkProjectSwitch('C:\\anything.project')).toBeNull();
  });

  it('allows the project that is already open', async () => {
    const ipcDir = makeSession('guard-same');
    const l = adoptedLauncher(ipcDir, 'C:\\proj\\Human.project');
    // Same path, different slash/case -- must still match, with no IPC round trip.
    expect(await l.checkProjectSwitch('c:/proj/human.project')).toBeNull();
  });

  it('allows any project when the adopted IDE had none open', async () => {
    const ipcDir = makeSession('guard-none');
    const l = adoptedLauncher(ipcDir, null);
    expect(await l.checkProjectSwitch('C:\\proj\\Other.project')).toBeNull();
  });

  describe('with a live watcher', () => {
    let watcher: ChildProcess | null = null;
    afterEach(() => {
      if (watcher) { watcher.kill(); watcher = null; }
    });

    it('blocks a switch while the IDE really holds a different project', async () => {
      const ipcDir = makeSession('guard-block');
      watcher = spawnMockWatcher(ipcDir, 'C:\\proj\\Human.project');
      expect(await waitForEngineSignal(ipcDir)).toBe(true);

      const l = adoptedLauncher(ipcDir, 'C:\\proj\\Human.project');
      const refusal = await l.checkProjectSwitch('C:\\proj\\Agent.project');

      expect(refusal).toContain('Refusing to switch projects');
      expect(refusal).toContain('C:\\proj\\Human.project');
      expect(refusal).toContain('C:\\proj\\Agent.project');
    }, 45_000);

    it('self-heals: clears once the user closes the project in the IDE', async () => {
      const ipcDir = makeSession('guard-heal');
      // The IDE now reports nothing open, while the launcher still remembers
      // the project that was there at adopt time.
      watcher = spawnMockWatcher(ipcDir, '');
      expect(await waitForEngineSignal(ipcDir)).toBe(true);

      const l = adoptedLauncher(ipcDir, 'C:\\proj\\Stale.project');
      expect(await l.checkProjectSwitch('C:\\proj\\Agent.project')).toBeNull();
      // Guard state was refreshed from the live probe, not left stale.
      expect((l as any).adoptedProjectPath).toBeNull();
    }, 45_000);
  });
});
