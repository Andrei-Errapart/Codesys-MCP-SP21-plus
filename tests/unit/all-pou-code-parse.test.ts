import { describe, it, expect } from 'vitest';
import { parseAllPouCodeOutput } from '../../src/server';

function buildIronPythonOutput(entries: Array<{ path: string; type: string; declaration?: string; implementation?: string }>): string {
  const jsonRaw = JSON.stringify(entries);
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
  it('prefers base64 export-path markers for PLCopenXML hand-off', () => {
    const exportPath = 'C:\\Projects\\\u6e29\u5ea6.project\\_pou_export.xml';
    const wire = [
      'DEBUG: export-based bulk read',
      '### ALL_POU_CODE_EXPORT_PATH_B64_START ###',
      Buffer.from(exportPath, 'utf-8').toString('base64'),
      '### ALL_POU_CODE_EXPORT_PATH_B64_END ###',
      'SCRIPT_SUCCESS: Export-based POU retrieval completed.',
    ].join('\n');

    expect(/^[\x00-\x7F]*$/.test(wire)).toBe(true);

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.kind).toBe('export_path');
    if (parsed.payload.kind !== 'export_path') return;
    expect(parsed.payload.exportPath).toBe(exportPath);
  });

  it('round-trips Chinese comments through legacy \\uXXXX-escaped JSON', () => {
    const decl = 'PROGRAM PLC_PRG\nVAR\n  // \u6e29\u5ea6\u9608\u503c\n  rTemp : REAL := 75.5;\nEND_VAR';
    const impl = '// \u4e3b\u63a7\u903b\u8f91\nIF rTemp > 80 THEN\n  // \u62a5\u8b66\nEND_IF;';

    const wire = buildIronPythonOutput([
      { path: 'Application/PLC_PRG', type: 'Program', declaration: decl, implementation: impl },
    ]);

    expect(/^[\x00-\x7F]*$/.test(wire)).toBe(true);
    expect(wire).toContain('\\u6e29\\u5ea6');

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.kind).toBe('entries');
    if (parsed.payload.kind !== 'entries') return;
    expect(parsed.payload.entries).toHaveLength(1);
    expect(parsed.payload.entries[0].path).toBe('Application/PLC_PRG');
    expect(parsed.payload.entries[0].declaration).toBe(decl);
    expect(parsed.payload.entries[0].implementation).toBe(impl);
    expect(parsed.payload.entries[0].declaration).toContain('\u6e29\u5ea6\u9608\u503c');
    expect(parsed.payload.entries[0].implementation).toContain('\u4e3b\u63a7\u903b\u8f91');
    expect(parsed.payload.entries[0].implementation).toContain('\u62a5\u8b66');
  });

  it('accepts inline PLCopenXML payloads for backward compatibility', () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><project><pou name="\u6e29\u5ea6"/></project>';
    const jsonRaw = JSON.stringify({ source: 'plcopen_xml_export', xml });
    const escaped = jsonRaw.replace(/[\u0080-\uFFFF]/g, (c) =>
      '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    );
    const wire = [
      '### ALL_POU_CODE_START ###',
      escaped,
      '### ALL_POU_CODE_END ###',
    ].join('\n');

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.kind).toBe('xml');
    if (parsed.payload.kind !== 'xml') return;
    expect(parsed.payload.xml).toBe(xml);
  });

  it('round-trips mixed ASCII + Chinese across multiple entries', () => {
    const wire = buildIronPythonOutput([
      { path: 'Application/A', type: 'Program', declaration: 'PROGRAM A\nVAR x : INT; END_VAR', implementation: 'x := 1;' },
      { path: 'Application/B', type: 'FunctionBlock', declaration: 'FUNCTION_BLOCK B\nVAR\n  (* \u72b6\u6001\u673a *)\n  y : INT;\nEND_VAR', implementation: 'y := y + 1; // \u8ba1\u6570' },
      { path: 'Application/\u7535\u673a', type: 'Program', declaration: 'PROGRAM \u7535\u673a\nVAR END_VAR', implementation: '// no-op' },
    ]);

    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.kind).toBe('entries');
    if (parsed.payload.kind !== 'entries') return;
    expect(parsed.payload.entries).toHaveLength(3);
    expect(parsed.payload.entries[1].declaration).toContain('(* \u72b6\u6001\u673a *)');
    expect(parsed.payload.entries[1].implementation).toContain('// \u8ba1\u6570');
    expect(parsed.payload.entries[2].path).toBe('Application/\u7535\u673a');
  });

  it('returns ok=false / missing_markers when no supported marker set is present', () => {
    const parsed = parseAllPouCodeOutput('SCRIPT_SUCCESS: but no markers anywhere');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('missing_markers');
  });

  it('returns ok=false / json_parse_failed when legacy payload is not valid JSON', () => {
    const wire = [
      '### ALL_POU_CODE_START ###',
      '{this is not json',
      '### ALL_POU_CODE_END ###',
    ].join('\n');
    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('json_parse_failed');
  });

  it('returns ok=false / path_decode_failed when the export path marker payload is invalid base64', () => {
    const wire = [
      '### ALL_POU_CODE_EXPORT_PATH_B64_START ###',
      'not-base64%%%'
      , '### ALL_POU_CODE_EXPORT_PATH_B64_END ###',
    ].join('\n');
    const parsed = parseAllPouCodeOutput(wire);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('path_decode_failed');
  });

  it('handles empty legacy entry arrays', () => {
    const parsed = parseAllPouCodeOutput(buildIronPythonOutput([]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.kind).toBe('entries');
    if (parsed.payload.kind !== 'entries') return;
    expect(parsed.payload.entries).toEqual([]);
  });
});
