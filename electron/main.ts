import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerHardwareIpc } from './ipc/hardware';
import { registerProjectIpc } from './ipc/project';
import { registerSettingsIpc } from './ipc/settings';
import { registerMediaIpc } from './ipc/media';
import { registerAudioIpc } from './ipc/audio';
import { registerEdgeTtsIpc } from './ipc/edgetts';
import { registerFfmpegIpc } from './ipc/ffmpeg';
import { registerMusicIpc } from './ipc/music';
import { registerCharacterIpc } from './ipc/character';
import { registerYtdlpIpc } from './ipc/ytdlp';
import { registerWhisperIpc } from './ipc/whisper';
import { registerUpdater, startUpdateChecks } from './updater';

// Vite injects these in dev; undefined in a packaged build.
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Custom scheme for the OAuth deep-link. Supabase redirects here after Google
// sign-in in the system browser; the main process parses the tokens and hands
// them to the renderer.
const AUTH_PROTOCOL = 'gensuite';

// A standard, secure app-only scheme lets the renderer display downloaded
// project files in both Vite dev mode (http://) and the packaged app (file://).
protocol.registerSchemesAsPrivileged([
  { scheme: 'gensuite-file', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#131314',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  if (DEV_URL) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// Pull the OAuth tokens out of a gensuite://auth-callback#access_token=…&refresh_token=…
// deep-link and forward them to the renderer, which calls supabase.setSession().
function handleAuthDeepLink(url: string): void {
  if (!url || !url.startsWith(`${AUTH_PROTOCOL}://`)) return;
  try {
    // The tokens live in the URL fragment; normalize so URLSearchParams can read them.
    const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1, url.includes('#') ? url.indexOf('#') : undefined) : '';
    const params = new URLSearchParams(hash || query);
    const accessToken = params.get('access_token') ?? '';
    const refreshToken = params.get('refresh_token') ?? '';
    if (!accessToken || !refreshToken) return;
    const target = win;
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.focus();
    target.webContents.send('auth:callback', { accessToken, refreshToken });
  } catch {
    // Ignore malformed deep-links.
  }
}

function registerWindowIpc(): void {
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    // Only allow http(s) so a compromised renderer can't launch arbitrary protocols.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function registerIpc(): void {
  registerWindowIpc();
  registerHardwareIpc();
  registerProjectIpc();
  registerSettingsIpc();
  registerMediaIpc();
  registerAudioIpc();
  registerEdgeTtsIpc();
  registerFfmpegIpc();
  registerMusicIpc();
  registerCharacterIpc();
  registerYtdlpIpc();
  registerWhisperIpc();
}

function registerProjectFileProtocol(): void {
  const root = path.resolve(app.getPath('userData'), 'GenSuite', 'projects');
  protocol.handle('gensuite-file', async (request) => {
    const url = new URL(request.url);
    const decoded = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, '$1');
    const file = path.resolve(decoded);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const bytes = await fs.readFile(file);
      const range = request.headers.get('range');
      const baseHeaders = {
        'Content-Type': contentType(file),
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      };
      if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const requestedEnd = match[2] ? Number(match[2]) : bytes.length - 1;
          const end = Math.min(requestedEnd, bytes.length - 1);
          if (start >= 0 && start <= end) {
            const chunk = bytes.subarray(start, end + 1);
            return new Response(new Uint8Array(chunk), {
              status: 206,
              headers: {
                ...baseHeaders,
                'Content-Length': String(chunk.length),
                'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
              },
            });
          }
        }
      }
      return new Response(new Uint8Array(bytes), {
        headers: { ...baseHeaders, 'Content-Length': String(bytes.length) },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.mp4': return 'video/mp4';
    case '.jpeg':
    case '.jpg':
    default: return 'image/jpeg';
  }
}

// Single-instance lock: the OAuth deep-link relaunches the app, and we need the
// running instance to receive the tokens instead of spawning a second window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows/Linux deliver the deep-link as an argv of the second launch.
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`));
    if (url) handleAuthDeepLink(url);
    else {
      if (win?.isMinimized()) win.restore();
      win?.focus();
    }
  });

  // macOS delivers it via open-url.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleAuthDeepLink(url);
  });

  // Register as the handler for gensuite:// so the OS routes the callback here.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
  }

  app.whenReady().then(() => {
    registerProjectFileProtocol();
    registerIpc();
    registerUpdater(() => win);
    createWindow();

    // A cold start triggered by the deep-link carries the URL in argv (Win/Linux).
    const initialUrl = process.argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`));
    if (initialUrl) handleAuthDeepLink(initialUrl);

    // Only poll for updates in a packaged build — dev has no published feed.
    if (!DEV_URL) startUpdateChecks();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
