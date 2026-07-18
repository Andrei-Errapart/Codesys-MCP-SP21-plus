import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'src', 'scripts');

/**
 * Guard for the interpolation contract (see ScriptManager.interpolate).
 *
 * A QUOTED placeholder (`X = "{KEY}"`) is escaped into a Python literal by
 * ScriptManager, so arbitrary user text is safe there. A BARE placeholder
 * (`X = {KEY}`) is inserted VERBATIM -- it is a hole straight into the
 * generated program, and is only safe if the call site passes a Python
 * expression it constructed itself (pyStringLiteral / pyBool / a number /
 * a list literal).
 *
 * This test pins the set of bare placeholders. Adding a new one is a
 * deliberate act that has to be justified here, which is what stops the
 * next tool from quietly reintroducing the `rename_object` RCE:
 * a POU name of `x"; import os; os.system("calc"); y = "z` used to become
 * live code in the generated script.
 */

/** Bare placeholders, each verified to receive a Python expression. */
const ALLOWED_BARE = new Set([
  // --- pyStringLiteral(...) at the call site -------------------------------
  'ADMIN_PASSWORD', 'ADMIN_USER', 'AUTHOR', 'COMMENT', 'COMPANY',
  'DESCRIPTION', 'DEVICE_PASSWORD', 'DEVICE_USER', 'EVENT', 'FULL_NAME',
  'NEW_VALUE', 'PARAM_NAME', 'PASSWORD', 'PLC_DIRECTORY', 'PLC_PATH',
  'TITLE', 'VERSION',
  // --- Python list literals built from pyStringLiteral elements ------------
  'ASSIGNMENTS_PY', 'EXPRESSIONS_PY',
  // --- pyBool(...) / 'True' | 'False' --------------------------------------
  'COMPACT', 'EXCLUDE', 'FORCE_OVERWRITE', 'GET_ONLY',
  'IMPORT_FOLDER_STRUCTURE', 'IS_DIRECTORY', 'ONLINE_MODE', 'RECURSIVE',
  'RESTORE', 'SAVE_FIRST', 'SET_DECLARATION', 'SET_IMPLEMENTATION',
  // --- integers (zod .int(), or derived from Number) -----------------------
  'LOGIN_WAIT_SECONDS', 'NEW_INDEX',
]);

interface Found {
  file: string;
  line: number;
  key: string;
  text: string;
}

function scanTemplates(): { bare: Found[]; quoted: Found[] } {
  const bare: Found[] = [];
  const quoted: Found[] = [];

  for (const f of fs.readdirSync(SCRIPTS_DIR)) {
    if (!f.endsWith('.py')) continue;
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf-8');
    src.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('#')) return; // commented-out examples
      const re = /\{([A-Z][A-Z0-9_]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const before = line.slice(0, m.index);
        const after = line.slice(m.index + m[0].length);
        const hit: Found = { file: f, line: i + 1, key: m[1], text: line.trim() };

        // Exactly-wrapping quote, with optional r/u prefix -- the form
        // ScriptManager rewrites into an escaped literal.
        const q = /(?:^|[^\w"'])([ru]{0,2})(["'])$/.exec(before);
        if (q && after.startsWith(q[2])) {
          quoted.push(hit);
        } else {
          bare.push(hit);
        }
      }
    });
  }
  return { bare, quoted };
}

describe('script template placeholder safety', () => {
  it('every bare placeholder is on the reviewed allowlist', () => {
    const { bare } = scanTemplates();
    const unexpected = bare.filter((b) => !ALLOWED_BARE.has(b.key));
    const detail = unexpected
      .map((b) => `  ${b.file}:${b.line}  {${b.key}}  |  ${b.text.slice(0, 80)}`)
      .join('\n');
    expect(
      unexpected,
      `Bare {PLACEHOLDER}s are interpolated VERBATIM into generated Python.\n` +
        `If the value is user text, quote it in the template (X = "{KEY}") so\n` +
        `ScriptManager escapes it. If it really is a Python expression built\n` +
        `by the caller, add it to ALLOWED_BARE with a note.\n${detail}`
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const { bare } = scanTemplates();
    const present = new Set(bare.map((b) => b.key));
    const stale = [...ALLOWED_BARE].filter((k) => !present.has(k));
    expect(stale, `Allowlist entries no longer present in any template: ${stale.join(', ')}`)
      .toEqual([]);
  });

  it('no template embeds a placeholder in a triple-quoted literal', () => {
    // Triple-quoted payload params were how a declaration ending in a double
    // quote produced a SyntaxError, and how non-ASCII became a byte string.
    // Bulk text travels as base64 now; nothing should regress to this form.
    for (const f of fs.readdirSync(SCRIPTS_DIR)) {
      if (!f.endsWith('.py')) continue;
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf-8');
      expect(src, `${f} must not interpolate into a triple-quoted literal`).not.toMatch(
        /(?:[ru]{0,2})"""\{[A-Z][A-Z0-9_]*\}"""/
      );
    }
  });

  it('templates are ASCII-only', () => {
    for (const f of fs.readdirSync(SCRIPTS_DIR)) {
      if (!f.endsWith('.py')) continue;
      const body = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'latin1');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(body), `${f} must be ASCII-only`).toBe(true);
    }
  });
});
