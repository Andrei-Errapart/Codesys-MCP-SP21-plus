import { describe, it, expect } from 'vitest';
import { parseAllPouCodeOutput } from '../../src/server';

/**
 * get_all_pou_code.py emits its JSON payload via
 * `json.dumps(all_code, ensure_ascii=True)`, which on IronPython 2.7 turns
 * every non-ASCII char into a \uXXXX escape. The script's own stdout then
 * rides through the watcher's stdout buffer and through
 * watcher.py's `json.dumps(result, ensure_ascii=True)` -- so by the time
 * parseAllPouCodeOutput sees the text, Chinese characters appear as escape
 * sequences inside the JSON, NOT as raw UTF-8 bytes. The test below
 * reproduces exactly that wire format and verifies JSON.parse decodes the
 * escapes back to real Han characters.
 */

function buildIronPythonOutput(entries: Array<{ path: string; type: string; declaration?: string; implementation?: string }>): string {
  const jsonRaw = JSON.stringify(entries);
  // Escape every BMP codepoint > 0x7F to \uXXXX so the wire format matches
  // what the IronPython side actually produces. (Astral plane / surrogate
  // pairs aren't exercised here; the IronPython path encodes them as a
  // \uXXXX\uXXXX surrogate pair which JSON.parse handles identically.)
  const escaped = jsonRaw.replace(/[\u0080-\uFFFF]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
  return [
    'DEBUG: get_all_pou_code script: ...',
    '### ALL_POU_CODE_START ###',
    escaped,
    '### ALL_POU_CODE_END ###',
    'Total POUs with code: ' + entries.length,
    'SCRIPT_SUCCESS: All POU code retrieved.',
  ].join('\n');
}

describe('parseAllPouCodeOutput', () => {
  it('round-trips Chinese comments through \\uXXXX-escaped JSON', () => {
    const decl = 'PROGRAM PLC_PRG\nVAR\n  // 温度阈值\n  rTemp : REAL := 75.5;\nEND_VAR';
    const impl = '// 主控逻辑\nIF rTemp > 80 THEN\n  // 报警\nEND_IF;';

    const wire = buildIronPythonOutput([
      { path: 'Application/PLC_PRG', type: 'Program', declaration: decl, implementation: impl },
    ]);

    // Sanity: the wire format is pure ASCII (this is the IronPython contract).
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(wire)).toBe(true);
    // And it contains the escaped form of the Han characters in '温度'.
    expect(wire).toContain('\\u6e29\\u5ea6');

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].path).toBe('Application/PLC_PRG');
    // The whole point: parsed strings come back as real Unicode, not as
    // literal \uXXXX text.
    expect(parsed.entries[0].declaration).toBe(decl);
    expect(parsed.entries[0].implementation).toBe(impl);
    expect(parsed.entries[0].declaration).toContain('温度阈值'); // 温度阈值
    expect(parsed.entries[0].implementation).toContain('主控逻辑'); // 主控逻辑
    expect(parsed.entries[0].implementation).toContain('报警'); // 报警
  });

  it('round-trips mixed ASCII + Chinese across multiple entries', () => {
    const wire = buildIronPythonOutput([
      { path: 'Application/A', type: 'Program', declaration: 'PROGRAM A\nVAR x : INT; END_VAR', implementation: 'x := 1;' },
      { path: 'Application/B', type: 'FunctionBlock', declaration: 'FUNCTION_BLOCK B\nVAR\n  (* 状态机 *)\n  y : INT;\nEND_VAR', implementation: 'y := y + 1; // 计数' },
      { path: 'Application/电机', type: 'Program', declaration: 'PROGRAM 电机\nVAR END_VAR', implementation: '// no-op' },
    ]);

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[1].declaration).toContain('(* 状态机 *)'); // 状态机
    expect(parsed.entries[1].implementation).toContain('// 计数'); // 计数
    // The path field carries Chinese fine via the same JSON channel
    // (we still tell users to use ASCII paths -- this test just confirms
    // the parse layer doesn't corrupt them on the way through).
    expect(parsed.entries[2].path).toBe('Application/电机'); // 电机
  });

  it('returns ok=false / missing_markers when start/end markers absent', () => {
    const r = parseAllPouCodeOutput('SCRIPT_SUCCESS: but no markers anywhere');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing_markers');
  });

  it('returns ok=false / json_parse_failed when payload is not valid JSON', () => {
    const wire = [
      '### ALL_POU_CODE_START ###',
      '{this is not json',
      '### ALL_POU_CODE_END ###',
    ].join('\n');
    const r = parseAllPouCodeOutput(wire);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('json_parse_failed');
  });

  it('handles empty entries array', () => {
    const wire = buildIronPythonOutput([]);
    const r = parseAllPouCodeOutput(wire);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
  });
});
