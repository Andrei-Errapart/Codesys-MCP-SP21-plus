/**
 * Shape of `tui-live-values.json` written by the server's live-values pump.
 * The TUI Viewer reads this to overlay live runtime values inline next to
 * declared variable names.
 *
 * One file per machine; keyed by which POU the user is currently looking at
 * in `tui-state.json` so the TUI knows whether the values match its current
 * view and can ignore stale snapshots from a previous selection.
 */
export interface LiveValuesPayload {
  version: 1;
  /** ISO 8601 timestamp of the moment the snapshot was written. */
  updated_at: string;
  /** Project root dir the runtime was queried for. Matches the project_dir field in tui-state.json. */
  project_dir: string;
  /** Device name the runtime belongs to. Matches the device field in tui-state.json. */
  device: string;
  /** POU the values were read from. Bare name (no path); matches tui-state.json's selection.name. */
  pou_name: string;
  /** Variable name -> value snapshot. Bare names (no `PLC_PRG.` prefix). */
  values: Record<string, LiveValueSnapshot>;
}

export interface LiveValueSnapshot {
  /** Live value as a string (whatever read_variable returned). */
  value: string;
  /** Optional declared type, populated when the pump can determine it. */
  type?: string;
  /** Per-value timestamp in ms since epoch. Useful when the snapshot was assembled across several reads. */
  ts: number;
}
