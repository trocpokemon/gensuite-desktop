import { app, ipcMain, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import log from 'electron-log';
import type { UpdaterStatus } from '../src/shared/types';
import { isNewerVersion } from '../src/shared/version';

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const CHECK_TIMEOUT_MS = 12_000;
const PUBLIC_CHECK_TIMEOUT_MS = 8_000;
const LATEST_RELEASE_URL = 'https://api.github.com/repos/trocpokemon/gensuite-desktop/releases/latest';
let latestStatus: UpdaterStatus = { kind: 'not-available' };
let checkWatchdog: NodeJS.Timeout | null = null;

async function checkPublishedRelease(): Promise<UpdaterStatus> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GenSuite-Desktop' },
    signal: AbortSignal.timeout(PUBLIC_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Published update check failed (${response.status})`);
  const payload = await response.json() as { tag_name?: unknown };
  const version = String(payload.tag_name ?? '').replace(/^v/i, '').trim();
  if (!/^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Published update version is invalid');
  return isNewerVersion(version, app.getVersion())
    ? { kind: 'available', version, manualDownload: true }
    : { kind: 'not-available' };
}

// Wires electron-updater to the renderer: forwards lifecycle events on the
// `updater:status` channel and accepts check/download/install commands. Only
// meaningful in a packaged build — a dev run has no published feed to poll.
export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = log;

  const send = (status: UpdaterStatus) => {
    if (status.kind !== 'checking' && checkWatchdog) {
      clearTimeout(checkWatchdog);
      checkWatchdog = null;
    }
    latestStatus = status;
    getWindow()?.webContents.send('updater:status', status);
    if (status.kind === 'checking') {
      if (checkWatchdog) clearTimeout(checkWatchdog);
      checkWatchdog = setTimeout(async () => {
        checkWatchdog = null;
        if (latestStatus.kind !== 'checking') return;
        try {
          const fallbackStatus = await checkPublishedRelease();
          if (latestStatus.kind === 'checking') send(fallbackStatus);
        } catch (error) {
          log.error('published update fallback failed', error);
          if (latestStatus.kind === 'checking') send({ kind: 'error', message: 'Không thể kiểm tra bản cập nhật. Hãy kiểm tra kết nối rồi thử lại.' });
        }
      }, CHECK_TIMEOUT_MS);
    }
  };

  autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ kind: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send({ kind: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ kind: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => {
    log.error('autoUpdater error', err);
    send({ kind: 'error', message: 'Không thể kiểm tra bản cập nhật. Vui lòng thử lại sau.' });
  });

  ipcMain.handle('updater:getStatus', () => latestStatus);
  ipcMain.on('updater:check', () => {
    if (!app.isPackaged) {
      send({ kind: 'checking' });
      void checkPublishedRelease().then(send).catch((error) => {
        log.error('development update check failed', error);
        send({ kind: 'error', message: 'Không thể kiểm tra bản cập nhật. Hãy kiểm tra kết nối rồi thử lại.' });
      });
      return;
    }
    autoUpdater.checkForUpdates().then((result) => {
      if (latestStatus.kind !== 'checking') return;
      const version = result?.updateInfo?.version;
      if (version && isNewerVersion(version, app.getVersion())) send({ kind: 'available', version });
      else send({ kind: 'not-available' });
    }).catch(async (error) => {
      log.error('checkForUpdates failed', error);
      try {
        send(await checkPublishedRelease());
      } catch (fallbackError) {
        log.error('published update check failed', fallbackError);
        send({ kind: 'error', message: 'Không thể kiểm tra bản cập nhật. Hãy kiểm tra kết nối rồi thử lại.' });
      }
    });
  });
  ipcMain.on('updater:download', () => {
    autoUpdater.downloadUpdate().catch((err) => {
      log.error('downloadUpdate failed', err);
      send({ kind: 'error', message: 'Không thể tải bản cập nhật. Vui lòng thử lại sau.' });
    });
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
