import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { ScriptManager } from '../../src/script-manager';

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'src', 'scripts');

describe('ScriptManager', () => {
  const mgr = new ScriptManager(SCRIPTS_DIR);

  it('loads an existing template', () => {
    const content = mgr.loadTemplate('check_status');
    expect(content).toContain('scriptengine');
    expect(content).toContain('SCRIPT_SUCCESS');
  });

  it('throws for non-existent template', () => {
    expect(() => mgr.loadTemplate('nonexistent_script')).toThrow(/not found/);
  });

  it('interpolates a single param', () => {
    const result = mgr.interpolate('hello {FOO}', { FOO: 'bar' });
    expect(result).toBe('hello bar');
  });

  // --- Interpolation contract -------------------------------------------
  //
  // A QUOTED placeholder (`X = "{KEY}"`, any quote style, any r/u prefix)
  // is replaced -- construct and all -- by a fully escaped Python literal.
  // A BARE placeholder (`X = {KEY}`) is inserted verbatim, for callers
  // supplying a Python expression.

  it('escapes backslashes and drops the raw-string prefix', () => {
    const result = mgr.interpolate('path = r"{PATH}"', {
      PATH: 'C:\\Users\\Test',
    });
    // The `r` prefix would defeat the escaping, so it is dropped and the
    // backslashes are escaped instead. Same value, but now a trailing
    // backslash can no longer produce a SyntaxError.
    expect(result).toBe('path = "C:\\\\Users\\\\Test"');
  });

  it('a trailing backslash no longer breaks the literal', () => {
    // `export_native`/`mirror_export` take DIRECTORY paths, where a trailing
    // separator is the natural thing to type. Under the old raw-string form
    // this produced `r"C:\exports\"` -- an unterminated string literal.
    const result = mgr.interpolate('dest = r"{DEST}"', { DEST: 'C:\\exports\\' });
    expect(result).toBe('dest = "C:\\\\exports\\\\"');
  });

  it('escapes embedded quotes so a value cannot inject Python', () => {
    // The rename_object RCE: this exact value used to close the literal and
    // leave `import os; os.system("calc")` as live code.
    const result = mgr.interpolate('NEW_NAME = "{NEW_NAME}"', {
      NEW_NAME: 'x"; import os; os.system("calc"); y = "z',
    });
    expect(result).toBe(
      'NEW_NAME = "x\\"; import os; os.system(\\"calc\\"); y = \\"z"'
    );
    expect(result).not.toContain('import os;   ');
  });

  it('escapes newlines rather than emitting a multi-line literal', () => {
    const result = mgr.interpolate('v = "{V}"', { V: 'a\nb' });
    expect(result).toBe('v = "a\\nb"');
  });

  it('renders non-ASCII as an ASCII-safe unicode literal', () => {
    // Keeps the generated .py pure ASCII so neither the IronPython source
    // decoder nor CODESYS's Encoding.Default stdout path can corrupt it.
    const result = mgr.interpolate('name = "{NAME}"', { NAME: '计数器' });
    expect(result).toBe('name = u"\\u8ba1\\u6570\\u5668"');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(result)).toBe(true);
  });

  it('handles single-quoted and prefixed placeholder spellings', () => {
    expect(mgr.interpolate("a = '{A}'", { A: "it's" })).toBe('a = "it\'s"');
    expect(mgr.interpolate("b = r'{B}'", { B: 'C:\\x' })).toBe('b = "C:\\\\x"');
    expect(mgr.interpolate('c = u"{C}"', { C: 'plain' })).toBe('c = "plain"');
  });

  it('inserts BARE placeholders verbatim (caller supplies a Python expression)', () => {
    // This is how booleans, ints and base64 payloads travel.
    const result = mgr.interpolate('FLAG = {FLAG}\nN = {N}', { FLAG: 'True', N: '42' });
    expect(result).toBe('FLAG = True\nN = 42');
  });

  it('interpolates multiple params', () => {
    const result = mgr.interpolate('{A} and {B}', { A: 'x', B: 'y' });
    expect(result).toBe('x and y');
  });

  it('two loads return identical content (no cache, fresh file read each call)', () => {
    const first = mgr.loadTemplate('check_status');
    const second = mgr.loadTemplate('check_status');
    expect(first).toEqual(second);
  });

  it('combineScripts concatenates with double newlines', () => {
    const result = mgr.combineScripts('script1', 'script2', 'script3');
    expect(result).toBe('script1\n\nscript2\n\nscript3');
  });

  it('prepareScript loads and interpolates', () => {
    // create_project has {PROJECT_FILE_PATH} and {TEMPLATE_PROJECT_PATH} placeholders
    const result = mgr.prepareScript('create_project', {
      PROJECT_FILE_PATH: 'C:\\Projects\\test.project',
      TEMPLATE_PROJECT_PATH: 'C:\\Templates\\Standard.project',
    });
    // Rendered as escaped Python literals, so backslashes are doubled.
    expect(result).toContain('C:\\\\Projects\\\\test.project');
    expect(result).toContain('C:\\\\Templates\\\\Standard.project');
  });

  it('prepareScriptWithHelpers prepends helpers', () => {
    const result = mgr.prepareScriptWithHelpers(
      'open_project',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      ['ensure_project_open']
    );
    // ensure_project_open content should appear before open_project content
    const ensureIdx = result.indexOf('def ensure_project_open');
    const openIdx = result.indexOf('Project Opened');
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeLessThan(openIdx);
  });

  it('Windows path with spaces passes through correctly', () => {
    const result = mgr.interpolate('path = r"{PATH}"', {
      PATH: 'C:\\Program Files\\CODESYS',
    });
    expect(result).toBe('path = "C:\\\\Program Files\\\\CODESYS"');
  });

  it('EVERY script template is ASCII-only (IronPython 2.7, no coding declaration)', () => {
    const fs = require('fs');
    const dir = path.join(__dirname, '..', '..', 'src', 'scripts');
    // withFileTypes so a directory is skipped rather than read: running
    // python against a script here leaves a __pycache__ behind, and
    // readFileSync on it fails with a bare EISDIR that says nothing about
    // what this test is checking.
    const entries = fs.readdirSync(dir, { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
    }>;
    let checked = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const body = fs.readFileSync(path.join(dir, entry.name), 'latin1');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(body), `${entry.name} must be ASCII-only`).toBe(true);
      checked++;
    }
    // Without this the test passes vacuously if the filter ever excludes
    // everything -- an ASCII guard that silently checks nothing is worse
    // than no guard, because it still reports green.
    expect(checked, 'expected at least one script template to check').toBeGreaterThan(0);
  });

  it('dollar sequences in values are NOT treated as regex replacement patterns', () => {
    // IEC string literals use $ escapes ($R$N, $$ for a literal $). A plain
    // string replacement would collapse '$$' to '$' and expand '$&'.
    const result = mgr.interpolate('value = "{VALUE}"', {
      VALUE: "'$R$N' and $$ and $& stay verbatim",
    });
    expect(result).toBe('value = "\'$R$N\' and $$ and $& stay verbatim"');
  });
});
