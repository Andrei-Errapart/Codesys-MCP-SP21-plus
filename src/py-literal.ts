/**
 * Python string-literal escaping for values interpolated into generated
 * IronPython 2.7 scripts.
 *
 * Lives in its own module (rather than server.ts) so script-manager.ts can
 * use it without a circular import.
 */

/**
 * Render an arbitrary JS string as a Python string literal.
 *
 * Two properties matter, and both are load-bearing:
 *
 * 1. NOTHING can escape the literal. Quotes, backslashes, newlines and
 *    control characters are all escaped, so no tool argument can inject
 *    Python statements. A value ending in a backslash (`C:\exports\`) or a
 *    quote also stops being a SyntaxError.
 *
 * 2. THE OUTPUT IS PURE ASCII. Non-ASCII is emitted as \uXXXX inside a
 *    `u"..."` literal. That keeps the generated .py source ASCII-only, so
 *    neither the IronPython source decoder nor CODESYS's Encoding.Default
 *    stdout path can corrupt it -- the same reason bulk payloads travel as
 *    base64. The `u` prefix is required: in Python 2 a \uXXXX escape is only
 *    interpreted inside a unicode literal, and without it a Chinese POU name
 *    would reach the .NET API as a mojibake byte string.
 *
 * The `u` prefix is added ONLY when the value actually contains non-ASCII,
 * so the common case renders as a plain, readable `"MyPou"`.
 */
export function pyStringLiteral(s: string): string {
  let hasNonAscii = false;
  let out = '';

  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${cp.toString(16).padStart(2, '0')}`;
    } else if (cp <= 0x7e) {
      out += ch;
    } else {
      hasNonAscii = true;
      if (cp <= 0xffff) {
        out += `\\u${cp.toString(16).padStart(4, '0')}`;
      } else {
        // Astral plane: emit a surrogate pair. Narrow Python 2 builds --
        // which is what IronPython 2.7 is -- represent these as surrogate
        // pairs natively, so this round-trips.
        const v = cp - 0x10000;
        const hi = 0xd800 + (v >> 10);
        const lo = 0xdc00 + (v & 0x3ff);
        out += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
      }
    }
  }

  return `${hasNonAscii ? 'u' : ''}"${out}"`;
}

/** Python boolean literal from a JS boolean. */
export function pyBool(b: boolean): string {
  return b ? 'True' : 'False';
}
