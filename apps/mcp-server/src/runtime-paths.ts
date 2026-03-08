import { homedir } from 'os';
import { join, resolve } from 'path';

const APP_RUNTIME_DIR = 'browser-debug-mcp-bridge';

export function getRuntimeDataDir(): string {
  const explicitDataDir = process.env.DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolve(explicitDataDir);
  }

  const home = process.env.HOME || homedir();

  if (process.platform === 'win32') {
    const appDataRoot = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (appDataRoot) {
      return resolve(appDataRoot, APP_RUNTIME_DIR);
    }
  }

  if (process.platform === 'darwin' && home) {
    return resolve(home, 'Library', 'Application Support', APP_RUNTIME_DIR);
  }

  if (process.env.XDG_STATE_HOME) {
    return resolve(process.env.XDG_STATE_HOME, APP_RUNTIME_DIR);
  }

  if (process.env.XDG_DATA_HOME) {
    return resolve(process.env.XDG_DATA_HOME, APP_RUNTIME_DIR);
  }

  if (home) {
    return resolve(home, '.local', 'share', APP_RUNTIME_DIR);
  }

  return resolve(process.cwd(), '.browser-debug-mcp-bridge');
}

export function getDatabasePath(): string {
  return join(getRuntimeDataDir(), 'browser-debug.db');
}
