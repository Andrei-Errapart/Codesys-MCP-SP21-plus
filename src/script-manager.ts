/**
 * Python script template loading and interpolation.
 * Loads .py templates from src/scripts/ (or dist/scripts/) and performs
 * {PARAM} replacement. No caching: a tool call is ~1.5 s of CODESYS time,
 * so the few-ms cost of re-reading a small .py file each call is invisible
 * AND it means edits to dist/scripts/ are picked up live without an MCP
 * restart. This makes iterating on script-side fixes much faster
 * (relevant for the SP21+ scripting-engine drift bugs we hit on this fork).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScriptParams } from './types';
import { pyStringLiteral } from './py-literal';

const PY_UTF8_HEADER = '# -*- coding: utf-8 -*-';
const UNICODE_HELPER = 'unicode_text';

export class ScriptManager {
  private scriptsDir: string;

  constructor(scriptsDir?: string) {
    this.scriptsDir = scriptsDir ?? path.join(__dirname, 'scripts');
  }

  /** Synchronously read a template file. Re-reads on every call -- no cache. */
  loadTemplate(name: string): string {
    const fileName = name.endsWith('.py') ? name : `${name}.py`;
    const filePath = path.join(this.scriptsDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Script template not found: ${filePath}`);
    }
    // Normalise to LF: dist .py files arrive as CRLF on Windows (git autocrlf),
    // which IronPython 2.7's exec() rejects inside triple-quoted docstrings.
    // headless.js strips them per-script; doing it here covers the persistent
    // IPC path too without duplicating the rule.
    return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  }

  /**
   * Replace {KEY} placeholders with values.
   *
   * There are exactly two placeholder forms, and the template decides which
   * applies -- callers never have to remember to escape anything:
   *
   *   NAME = "{KEY}"   QUOTED. The whole `"{KEY}"` construct (including any
   *                    r/u prefix and single-quote spelling) is replaced with
   *                    a fully escaped Python string literal. Arbitrary text
   *                    is safe here: quotes, backslashes, newlines and
   *                    non-ASCII all survive, and nothing can break out of
   *                    the literal to inject Python statements.
   *
   *   NAME = {KEY}     BARE. Inserted verbatim. The caller is supplying a
   *                    Python expression -- True/False, an int, a base64
   *                    payload, a list literal. Never pass raw user text here.
   *
   * This used to be a naive textual substitution with the escaping duty
   * pushed onto ~150 call sites, which is exactly the kind of contract that
   * gets forgotten: a POU name of `x"; import os; os.system("calc"); y = "z`
   * became live code in the generated script. Doing it here means the safe
   * behaviour is the default and a new tool cannot opt out by accident.
   */
  interpolate(template: string, params: ScriptParams): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      const str = String(value);

      // Pass 1: quoted placeholders -> escaped Python literal.
      // The optional r/u prefix is deliberately dropped: pyStringLiteral
      // emits its own prefix, and a raw-string prefix would defeat the
      // backslash escaping we just applied.
      //
      // The lookarounds require the quote to be a LONE delimiter. Without
      // them, `"""{KEY}"""` would match its inner `"{KEY}"` and render as
      // `""<literal>""` -- a silent corruption. No template uses that form
      // any more (bulk text travels as base64, and a test enforces it), but
      // a substitution primitive should not be one edit away from breaking.
      const quoted = new RegExp(`(?<!["'])[ru]{0,2}(["'])\\{${key}\\}\\1(?!["'])`, 'g');
      result = result.replace(quoted, () => pyStringLiteral(str));

      // Pass 2: bare placeholders -> verbatim.
      // Function replacement: a plain string here would interpret
      // $-sequences ($$, $&, ...) in the VALUE as regex replacement
      // patterns, corrupting IEC string literals like '$R$N'.
      const bare = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(bare, () => str);
    }
    return result;
  }

  /** Prefix generated Python scripts with a UTF-8 source-encoding header. */
  private withUtf8Header(script: string): string {
    const normalised = script.replace(/^\uFEFF/, '');
    if (normalised.startsWith(PY_UTF8_HEADER)) return normalised;
    return `${PY_UTF8_HEADER}\n${normalised}`;
  }

  /** Concatenate multiple script fragments with double newlines */
  combineScripts(...scripts: string[]): string {
    return scripts.join('\n\n');
  }

  /** Always prepend the shared Unicode helper before every generated Python script. */
  private withDefaultHelpers(script: string): string {
    return this.combineScripts(this.loadTemplate(UNICODE_HELPER), script);
  }

  /** Load a template and interpolate parameters */
  prepareScript(name: string, params: ScriptParams): string {
    const template = this.withDefaultHelpers(this.loadTemplate(name));
    return this.interpolate(this.withUtf8Header(template), params);
  }

  /** Prepend helper scripts before the main script, then interpolate all */
  prepareScriptWithHelpers(
    name: string,
    params: ScriptParams,
    helpers: string[]
  ): string {
    const uniqueHelpers = [UNICODE_HELPER, ...helpers.filter((h) => h !== UNICODE_HELPER)];
    const helperContents = uniqueHelpers.map((h) => this.loadTemplate(h));
    const mainTemplate = this.loadTemplate(name);
    const combined = this.combineScripts(...helperContents, mainTemplate);
    return this.interpolate(this.withUtf8Header(combined), params);
  }
}
