/**
 * File-based IPC transport layer.
 * Writes command files, polls for result files, with command serialization.
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { IpcConfig, IpcResult, IpcCommand, RequestId } from './types';
import { ipcLog } from './logger';

/** Default IPC configuration */
export const DEFAULT_IPC_CONFIG: Omit<IpcConfig, 'baseDir'> = {
  commandTimeoutMs: 60_000,
  pollIntervalMs: 100,
  maxPollIntervalMs: 1_000,
  deleteResultAfterRead: true,
};

/**
 * Async mutex for serializing commands.
 * Ensures only one command is in-flight at a time.
 */
class AsyncMutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

/**
 * Atomic file write: write to .tmp then rename.
 * Uses fsync to ensure data is flushed to disk before rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, undefined, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

export class IpcClient {
  private config: IpcConfig;
  private mutex = new AsyncMutex();
  private commandsDir: string;
  private resultsDir: string;

  constructor(config: IpcConfig) {
    this.config = config;
    this.commandsDir = path.join(config.baseDir, 'commands');
    this.resultsDir = path.join(config.baseDir, 'results');
  }

  /** Create commands/ and results/ directories */
  async ensureDirectories(): Promise<void> {
    fs.mkdirSync(this.commandsDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });
    ipcLog.debug(`IPC directories created at ${this.config.baseDir}`);
  }

  /**
   * Check if the watcher script has started.
   *
   * NOTE: this is NOT "the scripting engine is usable" -- watcher.py writes
   * ready.signal before it imports scriptengine. Gate real readiness on
   * readEngineSignal(); this remains for diagnostics and to distinguish
   * "CODESYS never ran the script at all" from "the import failed".
   */
  async isReady(): Promise<boolean> {
    const signalPath = path.join(this.config.baseDir, 'ready.signal');
    return fs.existsSync(signalPath);
  }

  /**
   * Read engine.signal, written by the watcher only after `import
   * scriptengine` succeeds. Returns null until then.
   *
   * `pid` is CODESYS.exe's own PID as seen from inside the process -- the
   * only reliable source, since spawn(shell:true) hands us the cmd.exe
   * wrapper's PID instead.
   */
  async readEngineSignal(): Promise<{ pid: number | null; version: string | null } | null> {
    const signalPath = path.join(this.config.baseDir, 'engine.signal');
    try {
      const parsed = JSON.parse(fs.readFileSync(signalPath, 'utf-8')) as {
        pid?: unknown;
        version?: unknown;
      };
      return {
        pid: typeof parsed.pid === 'number' ? parsed.pid : null,
        version: typeof parsed.version === 'string' ? parsed.version : null,
      };
    } catch {
      // Not written yet, or a torn read mid-rename -- caller retries.
      return null;
    }
  }

  /**
   * Read whatever the watcher recorded in watcher_error.txt.
   *
   * The watcher logs breadcrumbs there on the happy path too, so callers
   * that want "did it die" should look for the FATAL prefix specifically.
   * Without this the file was written, never read by anything, and then
   * deleted by cleanup() -- the one diagnostic for a failed launch.
   */
  readWatcherError(): string | null {
    try {
      const content = fs.readFileSync(
        path.join(this.config.baseDir, 'watcher_error.txt'),
        'utf-8'
      );
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /** Just the FATAL lines from watcher_error.txt, if any. */
  readWatcherFatal(): string | null {
    const content = this.readWatcherError();
    if (!content) return null;
    const fatal = content
      .split('\n')
      .filter((l) => l.includes('FATAL:') || l.includes('KeyboardInterrupt outside main loop'))
      .join('\n')
      .trim();
    return fatal || null;
  }

  /** Write terminate.signal to request watcher shutdown */
  async sendTerminate(): Promise<void> {
    const signalPath = path.join(this.config.baseDir, 'terminate.signal');
    await atomicWrite(signalPath, JSON.stringify({ timestamp: Date.now() }));
    ipcLog.info('Terminate signal sent');
  }

  /**
   * Send a command to the watcher and wait for result.
   * Serialized via async mutex — only one command in-flight at a time.
   */
  async sendCommand(scriptContent: string, timeoutMs?: number): Promise<IpcResult> {
    await this.mutex.acquire();
    try {
      return await this._sendCommandInternal(scriptContent, timeoutMs);
    } finally {
      this.mutex.release();
    }
  }

  private async _sendCommandInternal(
    scriptContent: string,
    timeoutMs?: number
  ): Promise<IpcResult> {
    const requestId: RequestId = uuidv4();
    const timeout = timeoutMs ?? this.config.commandTimeoutMs;
    const scriptFileName = `${requestId}.py`;
    const commandFileName = `${requestId}.command.json`;
    const resultFileName = `${requestId}.result.json`;

    const scriptPath = path.join(this.commandsDir, scriptFileName);
    const commandPath = path.join(this.commandsDir, commandFileName);
    const resultPath = path.join(this.resultsDir, resultFileName);

    ipcLog.debug(`Sending command ${requestId}`);

    // Step 1: Write .py script file with fsync
    await atomicWrite(scriptPath, scriptContent);

    // Step 2: Write .command.json (triggers watcher)
    const command: IpcCommand = {
      requestId,
      scriptPath: scriptPath,
      timestamp: Date.now(),
    };
    await atomicWrite(commandPath, JSON.stringify(command));

    ipcLog.debug(`Command ${requestId} written, polling for result...`);

    // Step 3: Poll for result with progressive backoff
    const startTime = Date.now();
    let pollInterval = this.config.pollIntervalMs;

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(resultPath)) {
        // Try to read result with retry for partial writes
        const result = await this._readResultWithRetry(resultPath, requestId);
        if (result) {
          // Clean up result file if configured
          if (this.config.deleteResultAfterRead) {
            try {
              fs.unlinkSync(resultPath);
            } catch {
              // Ignore cleanup errors
            }
          }
          ipcLog.debug(
            `Command ${requestId} completed: success=${result.success}`
          );
          return result;
        }
      }

      // Progressive backoff: double interval, cap at max
      await this._sleep(pollInterval);
      pollInterval = Math.min(pollInterval * 2, this.config.maxPollIntervalMs);
    }

    // Timeout — clean up command files
    this._cleanupCommandFiles(requestId);

    throw new Error(
      `Command ${requestId} timed out after ${timeout}ms waiting for result`
    );
  }

  /**
   * Read result file with retry for corrupted/partial JSON.
   * Up to 3 attempts with 100ms delay between.
   */
  private async _readResultWithRetry(
    resultPath: string,
    requestId: string
  ): Promise<IpcResult | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const content = fs.readFileSync(resultPath, 'utf-8');
        const result: IpcResult = JSON.parse(content);
        if (result.requestId === requestId) {
          return result;
        }
        ipcLog.warn(
          `Result file requestId mismatch: expected ${requestId}, got ${result.requestId}`
        );
        return null;
      } catch (err) {
        if (attempt < 2) {
          ipcLog.debug(
            `Result read attempt ${attempt + 1} failed, retrying in 100ms...`
          );
          await this._sleep(100);
        } else {
          ipcLog.warn(
            `Failed to read result after 3 attempts for ${requestId}: ${err}`
          );
          return null;
        }
      }
    }
    return null;
  }

  /** Clean up command files for a given request */
  private _cleanupCommandFiles(requestId: string): void {
    const scriptPath = path.join(this.commandsDir, `${requestId}.py`);
    const commandPath = path.join(
      this.commandsDir,
      `${requestId}.command.json`
    );
    try {
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(commandPath)) fs.unlinkSync(commandPath);
    } catch { /* ignore */ }
  }

  /** Remove the entire session directory */
  async cleanup(): Promise<void> {
    try {
      fs.rmSync(this.config.baseDir, { recursive: true, force: true });
      ipcLog.info(`Session directory cleaned up: ${this.config.baseDir}`);
    } catch (err) {
      ipcLog.warn(`Failed to clean up session directory: ${err}`);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
