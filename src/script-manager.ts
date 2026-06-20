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
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Replace {KEY} placeholders with values.
   * No automatic escaping — callers are responsible for escaping values
   * appropriate to their Python context (raw strings, triple-quoted strings, etc.).
   */
  interpolate(template: string, params: ScriptParams): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      const pattern = new RegExp(`\\{${key}\\}`, 'g');
      // Function replacement: a plain string here would interpret $-sequences
      // ($$, $&, ...) in the VALUE as regex replacement patterns, corrupting
      // IEC string literals like '$R$N' passed through tool params.
      result = result.replace(pattern, () => String(value));
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
