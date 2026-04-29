import * as os from 'os';
import * as path from 'path';

const APP_DIR = 'codesys-mcp';
const STATE_FILE = 'tui-state.json';
const LIVE_VALUES_FILE = 'tui-live-values.json';

function resolveStateDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA is not set; cannot resolve TUI state file path');
    }
    return path.win32.join(localAppData, APP_DIR);
  }
  const xdg = process.env.XDG_STATE_HOME;
  const home = process.env.HOME ?? os.homedir();
  const base = xdg ?? path.posix.join(home, '.local', 'state');
  return path.posix.join(base, APP_DIR);
}

function joinForPlatform(dir: string, file: string): string {
  return process.platform === 'win32' ? path.win32.join(dir, file) : path.posix.join(dir, file);
}

export function stateFilePath(): string {
  return joinForPlatform(resolveStateDir(), STATE_FILE);
}

export function liveValuesFilePath(): string {
  return joinForPlatform(resolveStateDir(), LIVE_VALUES_FILE);
}
