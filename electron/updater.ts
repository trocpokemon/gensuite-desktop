import { ipcMain, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import log from 'electron-log';
import type { UpdaterStatus } from '../src/shared/types';

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// Wires electron-updater to the renderer: forwards lifecycle events on the
// `updater:status` channel and accepts check/download/install commands. Only
// meaningful in a packaged build — a dev run has no published feed to poll.
export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;

  const send = (status: UpdaterStatus) => {
    getWindow()?.webContents.send('updater:status', status);
  };

  autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ kind: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send({ kind: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ kind: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => send({ kind: 'error', message: String(err?.message || err) }));

  ipcMain.on('updater:check', () => {
    autoUpdater.checkForUpdates().catch((err) => log.error('checkForUpdates failed', err));
  });
  ipcMain.on('updater:download', () => {
    autoUpdater.downloadUpdate().catch((err) => log.error('downloadUpdate failed', err));
  });
  ipcMain.on('updater:install', () => {
    autoUpdater.quitAndInstall();
  });
}

// Kick off an initial check plus a recurring poll. Call only in packaged builds.
export function startUpdateChecks(): void {
  autoUpdater.checkForUpdates().catch((err) => log.error('initial checkForUpdates failed', err));
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('scheduled checkForUpdates failed', err));
  }, CHECK_INTERVAL_MS);
}
