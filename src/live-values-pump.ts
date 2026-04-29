import * as fs from 'fs/promises';
import { writeLiveValues, LiveValueSnapshotIn } from './live-values-write';
import { readSelection } from './state-read';

const VAR_OPEN_RE = /^\s*(?:VAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_TEMP|_CONFIG|_EXTERNAL|_STAT)?)\b/i;
const VAR_CLOSE_RE = /^\s*END_VAR\b/i;
const VAR_DECL_RE = /^\s*([A-Za-z_]\w*)\b/;

/**
 * Parse all variable names declared in any VAR / VAR_INPUT / VAR_OUTPUT /
 * VAR_GLOBAL / etc. block. One name per declaration line; skips lines that
 * are entirely inside (* ... *) blocks (joined across lines) or are
 * `// ...` comments.
 *
 * Recognises the IEC declaration grammar enough for typical PLC code:
 * `name [AT %loc] : type [:= init];`. Doesn't try to parse multi-name
 * shorthand (`a, b : INT;`) — that's vanishingly rare in practice and
 * the cost of getting it wrong is just a missing overlay.
 */
export function parseVarNames(text: string): string[] {
  const names: string[] = [];
  const lines = text.split(/\r?\n/);
  let inVarBlock = false;
  let inMultilineComment = false;

  for (let raw of lines) {
    // Strip block comments first, threading the open-state across lines.
    let scrubbed = '';
    let i = 0;
    while (i < raw.length) {
      if (inMultilineComment) {
        const end = raw.indexOf('*)', i);
        if (end < 0) {
          i = raw.length;
        } else {
          inMultilineComment = false;
          i = end + 2;
        }
        continue;
      }
      if (raw[i] === '(' && raw[i + 1] === '*') {
        const end = raw.indexOf('*)', i + 2);
        if (end < 0) {
          inMultilineComment = true;
          i = raw.length;
        } else {
          i = end + 2;
        }
        continue;
      }
      scrubbed += raw[i];
      i++;
    }
    // Strip line comments.
    const slash = scrubbed.indexOf('//');
    if (slash >= 0) scrubbed = scrubbed.slice(0, slash);

    if (!inVarBlock) {
      if (VAR_OPEN_RE.test(scrubbed)) inVarBlock = true;
      continue;
    }
    if (VAR_CLOSE_RE.test(scrubbed)) {
      inVarBlock = false;
      continue;
    }
    const m = VAR_DECL_RE.exec(scrubbed);
    if (m) names.push(m[1]);
  }
  return names;
}

// ─── Pump ────────────────────────────────────────────────────────────────
//
// The full pump (interval + per-var read_variable round-trips) is wired
// up by Task 7 once the server-side plumbing is in place. parseVarNames
// is the only piece we can unit-test in isolation; the rest needs an
// executor + state-read + write integration.

export interface PumpDeps {
  /** Read the TUI selection state file. Defaults to readSelection. */
  readSelection?: typeof readSelection;
  /** Read the POU's mirror file from disk. */
  readPouFile?: (absPath: string) => Promise<string>;
  /** Read a single PLC variable. Returns its current value as a string. */
  readVariable?: (projectFilePath: string, variablePath: string) => Promise<string>;
  /** Write the live-values snapshot. Defaults to writeLiveValues. */
  writeLiveValues?: typeof writeLiveValues;
}

export interface PumpConfig {
  /** Path to tui-state.json. */
  stateFilePath: string;
  /** Path to tui-live-values.json. */
  liveValuesFilePath: string;
  /** Poll interval in ms. */
  intervalMs: number;
}

export class LiveValuesPump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private cfg: PumpConfig, private deps: Required<PumpDeps>) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sel = await this.deps.readSelection(this.cfg.stateFilePath);
      if (sel.status !== 'ok') return;
      const pou = sel.payload.selection;
      const text = await this.deps.readPouFile(pou.abs_path);
      const names = parseVarNames(text);
      if (names.length === 0) return;
      const values: Record<string, LiveValueSnapshotIn> = {};
      const ts = Date.now();
      for (const name of names) {
        try {
          const v = await this.deps.readVariable(
            sel.payload.project_dir,
            `${pou.name}.${name}`
          );
          values[name] = { value: v, ts };
        } catch {
          // single-var failure: skip silently, others may succeed
        }
      }
      await this.deps.writeLiveValues(this.cfg.liveValuesFilePath, sel.payload.project_dir, {
        device: sel.payload.device,
        pou_name: pou.name,
        values,
      });
    } catch {
      // Pump must never crash; swallow.
    } finally {
      this.busy = false;
    }
  }
}
