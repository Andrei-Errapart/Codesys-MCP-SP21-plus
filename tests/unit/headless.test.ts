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
import { parsePouCodeOutput } from '../../src/server';

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
    expect(String(tempWrite?.[1])).toContain('中文注释');

    fs.unlinkSync(fakeExe);
  });

  it('headless stdout carrying base64 chinese markers decodes via parsePouCodeOutput', async () => {
    // This covers the "headless mode" half of the README's Chinese
    // support guarantee. In headless mode there is no watcher.py; the
    // HeadlessExecutor spawns CODESYS --noUI per command and captures
    // stdout directly. get_pou_code.py emits its declaration/implementation
    // as base64(utf-8) between ### POU ... B64 ... ### markers. Because
    // the markers themselves and the base64 payload are pure ASCII, no
    // intermediate byte-conversion in headless.ts can corrupt them.
    // Together with parsePouCodeOutput on this side, the read path
    // round-trips Chinese byte-exact.
    const fakeExe = path.join(os.tmpdir(), `fake-codesys-${Date.now()}.exe`);
    fs.writeFileSync(fakeExe, '');

    const declIn = 'PROGRAM PLC_PRG\nVAR\n  // 温度 (°C)\n  rT : REAL := 25.0;\nEND_VAR';
    const implIn = '// 主循环\nrT := rT + 0.1; // 缓慢升温';
    const fakeStdout = [
      'DEBUG: Getting code: ...',
      '### POU DECLARATION B64 START ###',
      Buffer.from(declIn, 'utf-8').toString('base64'),
      '### POU DECLARATION B64 END ###',
      '### POU IMPLEMENTATION B64 START ###',
      Buffer.from(implIn, 'utf-8').toString('base64'),
      '### POU IMPLEMENTATION B64 END ###',
      'SCRIPT_SUCCESS: Code retrieved.',
      '',
    ].join('\n');
    // The wire is pure ASCII -- this is what makes headless's
    // stdout->Buffer->string round-trip robust regardless of console
    // codepage (cp936 / cp1252 / utf-8) on the spawning side.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(fakeStdout)).toBe(true);

    const mockedSpawn = vi.mocked(spawn);
    mockedSpawn.mockImplementation(() => {
      const child = new MockChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(fakeStdout, 'utf-8'));
        child.emit('close', 0);
      }, 0);
      return child as any;
    });

    const ex = new HeadlessExecutor({
      codesysPath: fakeExe,
      profileName: 'Test Profile',
      workspaceDir: os.tmpdir(),
    });

    const result = await ex.executeScript('# get_pou_code placeholder');
    expect(result.success).toBe(true);
    expect(result.output).toContain('SCRIPT_SUCCESS');

    const parsed = parsePouCodeOutput(result.output);
    // Byte-exact recovery of the Chinese source through the headless
    // executor's stdout buffer + the server-side b64 marker decoder.
    expect(parsed.declaration).toBe(declIn);
    expect(parsed.implementation).toBe(implIn);
    expect(parsed.declaration).toContain('温度');
    expect(parsed.implementation).toContain('缓慢升温');

    fs.unlinkSync(fakeExe);
  });
});
