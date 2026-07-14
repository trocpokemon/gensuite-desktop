import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import type { HardwareInfo } from '../../src/shared/types';

const execFileAsync = promisify(execFile);

const LOW_SPEC_THRESHOLD_MB = 6 * 1024;

async function scanWindows(): Promise<HardwareInfo> {
  // Query the primary video controller. AdapterRAM is bytes (capped at 4GB for
  // some drivers via WMI, so we also read the name to report the model).
  const { stdout } = await execFileAsync('wmic', [
    'path',
    'win32_VideoController',
    'get',
    'AdapterRAM,Name',
    '/format:csv',
  ]);

  let vramMB = 0;
  let gpuModel = 'Unknown GPU';
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // CSV header: Node,AdapterRAM,Name
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const ram = Number(parts[1]);
    const name = parts.slice(2).join(',').trim();
    if (Number.isFinite(ram) && ram > vramMB * 1024 * 1024) {
      vramMB = Math.round(ram / (1024 * 1024));
      if (name) gpuModel = name;
    }
  }

  return {
    vramMB,
    gpuModel,
    lowSpec: vramMB > 0 ? vramMB < LOW_SPEC_THRESHOLD_MB : os.totalmem() / (1024 * 1024) < 8192,
  };
}

async function scanFallback(): Promise<HardwareInfo> {
  // Non-Windows or WMI failure: we can't read VRAM without extra deps, so treat
  // low system RAM as a proxy and flag low-spec conservatively.
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  return {
    vramMB: 0,
    gpuModel: 'Unknown GPU',
    lowSpec: totalMB < 8192,
  };
}

export function registerHardwareIpc(): void {
  ipcMain.handle('hardware:scan', async (): Promise<HardwareInfo> => {
    try {
      if (process.platform === 'win32') return await scanWindows();
      return await scanFallback();
    } catch {
      return await scanFallback();
    }
  });
}
