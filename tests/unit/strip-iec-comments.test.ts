import { describe, it, expect } from 'vitest';
import { stripIecComments, findReservedIecIdentifiers } from '../../src/server';

describe('stripIecComments', () => {
  it('preserves line structure so the declaration scan still sees one decl per line', () => {
    const src = 'VAR\n  (* note *)\n  x : INT;\nEND_VAR';
    const out = stripIecComments(src);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('x : INT;');
    expect(out).not.toContain('note');
  });

  it('handles both (* *) and /* */ spellings', () => {
    expect(stripIecComments('a (* c *) b')).toBe('a         b');
    expect(stripIecComments('a /* c */ b')).toBe('a         b');
  });

  it('handles nested block comments', () => {
    const src = 'a (* x (* y *) z *) b';
    const out = stripIecComments(src);
    // Length is preserved and only the comment body is blanked -- the inner
    // `*)` must not terminate the outer comment early, or `z *)` would leak.
    expect(out).toHaveLength(src.length);
    expect(out.replace(/ /g, '')).toBe('ab');
  });

  it('strips // line comments without eating the newline', () => {
    const out = stripIecComments('a // c\nb');
    expect(out).toBe('a     \nb');
  });

  it('does not treat (* inside a string literal as a comment opener', () => {
    const src = "msg : STRING := '(*';\n  t : TIME;";
    const out = stripIecComments(src);
    // The declaration after the string must survive.
    expect(out).toContain('t : TIME;');
  });

  it('leaves comment-free code byte-identical', () => {
    const src = 'VAR\n  nSpeed : INT;\nEND_VAR';
    expect(stripIecComments(src)).toBe(src);
  });
});

describe('findReservedIecIdentifiers with comments', () => {
  it('no longer refuses a declaration whose block comment contains example decls', () => {
    // This is the regression: the whole call used to be refused because
    // `t : TIME;` and `s : STRING;` inside the comment were scanned.
    const decl = [
      'VAR',
      '  (* Usage example:',
      '       t : TIME;',
      '       s : STRING;',
      '  *)',
      '  tDelay : TIME;',
      'END_VAR',
    ].join('\n');
    expect(findReservedIecIdentifiers(decl)).toEqual([]);
  });

  it('still catches a real reserved identifier outside comments', () => {
    const decl = 'VAR\n  (* fine *)\n  S : REAL;\nEND_VAR';
    const warnings = findReservedIecIdentifiers(decl);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'S'");
  });

  it('still catches a reserved keyword in a multi-name declaration', () => {
    const warnings = findReservedIecIdentifiers('VAR\n  a, by, c : INT;\nEND_VAR');
    expect(warnings.some((w) => w.includes("'by'"))).toBe(true);
  });

  it('ignores a // commented-out declaration', () => {
    expect(findReservedIecIdentifiers('VAR\n  // d : DATE;\n  dNow : DATE;\nEND_VAR')).toEqual([]);
  });
});
