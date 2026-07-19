/**
 * Shared TypeScript types for codesys-mcp-sp21-plus-ch (Codesys-MCP-SP21+)
 */

export type RequestId = string;
export type SessionId = string;

/** Command file written by Node.js to commands/ directory */
export interface IpcCommand {
  requestId: RequestId;
  scriptPath: string;
  timestamp: number;
}

/** Result file written by watcher to results/ directory */
export interface IpcResult {
  requestId: RequestId;
  success: boolean;
  output: string;
  error: string;
  timestamp: number;
}

/** CODESYS process lifecycle state */
export type CodesysState = 'stopped' | 'launching' | 'ready' | 'stopping' | 'error';

/** Configuration for launching CODESYS */
export interface LauncherConfig {
  codesysPath: string;
  profileName: string;
  workspaceDir: string;
  /**
   * If true, take over a live watcher session left behind by a previous
   * server (typically one run with --keep-alive) instead of refusing to
   * launch alongside it. Off by default: adoption means driving a CODESYS
   * this server did not start, which a human may be working in.
   */
  adopt?: boolean;
  /**
   * If true, keep CODESYS's stock behaviour of leaving the IDE inert for the
   * whole life of the watcher script.
   *
   * By default the watcher ends the "lengthy operation" the ScriptEngine
   * opened on its behalf, so the window is usable while the watcher merely
   * polls, and re-enters one only for the duration of each command. Stock
   * CODESYS cannot distinguish "a script is running" from "a script is
   * working": the watcher runs forever, so the IDE would otherwise stay
   * disabled forever.
   *
   * Set this to restore the stock behaviour. The cost of the default is that
   * Cancel no longer interrupts the watcher while it is idle -- there is no
   * lengthy operation to abort -- so use terminate.signal or shutdown.
   */
  safeUi?: boolean;
}

/** Runtime status of the CODESYS launcher */
export interface LauncherStatus {
  state: CodesysState;
  pid: number | null;
  sessionId: SessionId | null;
  ipcDir: string | null;
  startedAt: number | null;
  lastError: string | null;
  /**
   * Whether this server spawned the CODESYS it is driving ('owned'), handed
   * one to the user ('detached', --keep-alive), or took over one it did not
   * start ('adopted', --adopt). Only 'owned' instances are ever killed.
   */
  ownership?: 'owned' | 'detached' | 'adopted';
  /** For adopted instances: the project the IDE had open when we took over. */
  adoptedProjectPath?: string | null;
}

/** IPC transport configuration */
export interface IpcConfig {
  baseDir: string;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  deleteResultAfterRead: boolean;
}

/** Full server configuration */
export interface ServerConfig extends LauncherConfig {
  autoLaunch: boolean;
  keepAlive: boolean;
  timeoutMs: number;
  fallbackHeadless: boolean;
  verbose: boolean;
  debug: boolean;
  mode: ExecutionMode;
  /**
   * If true, automatically run mirror_export after every modifying tool
   * (set_pou_code, create_*, delete_object, rename_object, add_library, etc.)
   * so an external editor watching <projectDir>/mcp-mirror/ sees the change
   * immediately. Failures are surfaced as a hint in the tool response, not
   * as a hard error -- the underlying edit already succeeded.
   */
  autoMirror: boolean;
  /**
   * If true, run a background pump that reads runtime values for the
   * variables of the user's currently-selected POU and writes them to
   * tui-live-values.json so the TUI Viewer can overlay them inline.
   * Off by default.
   */
  liveValues?: boolean;
  /**
   * Poll interval (ms) for the live-values pump. Default 500.
   * Clamped to [100, 60000]; values outside the range are coerced.
   */
  liveValuesIntervalMs?: number;
  /**
   * Whether to attach to the CODESYS-shipped MCP bridge's named pipe
   * (`\\.\pipe\codesys-mcp-bridge`) and republish its tools under an `ide_`
   * prefix on this server. Default 'auto' — try to attach, log and skip if
   * the bridge plugin isn't loaded (SP19/SP21, or SP22+ before the user
   * opens CODESYS). 'on' fails loudly if attach fails. 'off' disables.
   */
  ideBridge: 'auto' | 'on' | 'off';
}

/** Script template parameters */
export type ScriptParams = Record<string, string>;

/** Execution mode */
export type ExecutionMode = 'persistent' | 'headless';

/** Interface for script executors (both persistent and headless) */
export interface ScriptExecutor {
  executeScript(content: string, timeoutMs?: number): Promise<IpcResult>;
}
