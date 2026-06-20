import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

vi.mock('child_process', () => {
  return { spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { HeadlessExecutor } from '../../src/headless';

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

describe('HeadlessExecutor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes temp scripts as utf-8 for Unicode payload safety', async () => {
    const fakeExe = path.join(os.tmpdir(), `fake-codesys-${Date.now()}.exe`);
    fs.writeFileSync(fakeExe, '');

    const mockedSpawn = vi.mocked(spawn);
    mockedSpawn.mockImplementation(() => {
      const child = new MockChild();
      setTimeout(() => child.emit('close', 0), 0);
      return child as any;
    });

    const ex = new HeadlessExecutor({
      codesysPath: fakeExe,
      profileName: 'Test Profile',
      workspaceDir: os.tmpdir(),
    });

    const result = await ex.executeScript('print("中文注释")');
    expect(result.success).toBe(true);

    const mockedWrite = vi.mocked(fs.writeFileSync);
    const tempWrite = mockedWrite.mock.calls.find((c) =>
      String(c[0]).includes('codesys_script_')
    );
    expect(tempWrite?.[2]).toBe('utf-8');

    fs.unlinkSync(fakeExe);
  });
});
