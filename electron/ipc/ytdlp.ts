import { ipcMain, BrowserWindow, app, dialog, session } from 'electron';
import type { Cookie } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import { ffmpegBinary } from './ffmpeg';
import type { YtdlpDownloadArgs, YtdlpProgress } from '../../src/shared/types';

// Download a source video by URL using the bundled yt-dlp binary, then let it
// merge best video+audio into an mp4 via the bundled ffmpeg. Progress is parsed
// from yt-dlp's stdout `[download] NN.N%` lines and streamed to the renderer.

function ytdlpBinary(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'ytdlp')
    : path.join(app.getAppPath(), 'resources', 'ytdlp');
  return path.join(base, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

// Douyin feed/modal URLs like `douyin.com/jingxuan?modal_id=<id>` aren't matched
// by yt-dlp's Douyin extractor, so it falls back to the generic one and fails
// with "Unsupported URL". Rewrite them to the canonical `/video/<id>` form that
// the extractor recognizes. Other URLs pass through unchanged.
function normalizeSourceUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
    const id = u.searchParams.get('modal_id') ?? u.pathname.match(/\/video\/(\d+)/)?.[1];
    if (id && /^\d+$/.test(id)) return `https://www.douyin.com/video/${id}`;
  }
  return raw;
}

// Keep Douyin state in an isolated application session instead of reading the
// user's primary browser profile. Each download exports only the required state
// to a unique short-lived file, which is removed when the attempt finishes.
const DOUYIN_PARTITION = 'persist:douyin';
const DOUYIN_LOGIN_REQUIRED = 'DOUYIN_LOGIN_REQUIRED';
const DOUYIN_REQUIRED_COOKIE_NAMES = new Set(['ttwid', 's_v_web_id']);
const DOUYIN_REFRESH_COOKIE_NAMES = new Set([
  'ttwid', 's_v_web_id', '__ac_nonce', '__ac_signature', 'msToken',
]);
const TIKTOK_PARTITION = 'persist:tiktok';
const TIKTOK_LOGIN_REQUIRED = 'TIKTOK_LOGIN_REQUIRED';
const TIKTOK_AUTH_COOKIE_NAMES = new Set([
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss',
]);

let douyinLoginWindow: BrowserWindow | null = null;
let douyinLoginPromise: Promise<boolean> | null = null;
let tiktokLoginWindow: BrowserWindow | null = null;
let tiktokLoginPromise: Promise<boolean> | null = null;

function douyinCookiesPath(): string {
  return path.join(app.getPath('temp'), `gensuite-douyin-${process.pid}-${randomUUID()}.txt`);
}

function legacyDouyinCookiesPath(): string {
  return path.join(app.getPath('userData'), 'douyin-cookies.txt');
}

function tiktokCookiesPath(): string {
  return path.join(app.getPath('temp'), `gensuite-tiktok-${process.pid}-${randomUUID()}.txt`);
}

// Serialize Electron cookies into the Netscape cookies.txt format yt-dlp expects:
//   domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
function toNetscapeCookies(cookies: Cookie[]): string {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
    if (!c.name || [c.domain, c.path, c.name, c.value].some((value) => /[\t\r\n]/.test(value ?? ''))) continue;
    // hostOnly cookies bind to the exact domain; others (leading-dot) match
    // subdomains. yt-dlp uses column 2 to decide, so mirror Electron's flag.
    const includeSub = c.hostOnly ? 'FALSE' : 'TRUE';
    const domain = c.domain?.startsWith('.') || c.hostOnly ? c.domain ?? '' : `.${c.domain ?? ''}`;
    const secure = c.secure ? 'TRUE' : 'FALSE';
    // Session cookies have no expiry; give them a far-future one so yt-dlp keeps them.
    const expiry = c.session || !c.expirationDate ? 2147483647 : Math.floor(c.expirationDate);
    lines.push([domain, includeSub, c.path || '/', secure, String(expiry), c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function cookieIsFresh(cookie: Cookie): boolean {
  return cookie.session || !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000 + 60;
}

function hasRequiredDouyinCookies(cookies: Cookie[]): boolean {
  return [...DOUYIN_REQUIRED_COOKIE_NAMES].every((name) => cookies.some((cookie) => cookie.name === name && cookieIsFresh(cookie)));
}

async function getDouyinCookies(): Promise<Cookie[]> {
  const ses = session.fromPartition(DOUYIN_PARTITION);
  return await ses.cookies.get({ domain: 'douyin.com' });
}

// Export only Douyin-domain cookies into a short-lived file used by one download.
// The persistent browser partition retains the session; this plaintext file is
// removed in a finally block as soon as the download attempt finishes.
async function writeDouyinCookies(filePath: string): Promise<boolean> {
  const cookies = await getDouyinCookies();
  if (!hasRequiredDouyinCookies(cookies)) return false;
  await fs.writeFile(filePath, toNetscapeCookies(cookies), { encoding: 'utf8', mode: 0o600 });
  return true;
}

// Silently load Douyin in a hidden window so it sets its guest cookies, then
// harvest them into a temporary cookies file. No login or user interaction is
// needed. Resolve only when the minimum verification cookies are present; never
// persist an empty/partial file that would poison future attempts.
function harvestDouyinCookies(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bgWin = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: DOUYIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let written = false;
      try { written = await writeDouyinCookies(filePath); } catch { /* caller handles false */ }
      if (!bgWin.isDestroyed()) bgWin.destroy();
      resolve(written);
    };

    // Poll until the minimum verification cookie set is complete.
    const poll = setInterval(async () => {
      const cookies = await getDouyinCookies().catch(() => []);
      if (hasRequiredDouyinCookies(cookies)) { clearInterval(poll); await finish(); }
    }, 500);

    // Hard cap: don't hang the download if Douyin never provides the minimum
    // verification state. `finish` deliberately refuses a partial export.
    const timer = setTimeout(async () => { clearInterval(poll); await finish(); }, 15000);

    bgWin.loadURL('https://www.douyin.com/').catch(() => { /* poll/timeout still fire */ });
  });
}

async function clearDouyinCookiesByName(names: Set<string>): Promise<void> {
  const ses = session.fromPartition(DOUYIN_PARTITION);
  const cookies = await getDouyinCookies().catch(() => []);
  await Promise.all(cookies
    .filter((cookie) => names.has(cookie.name))
    .map((cookie) => {
      const domain = (cookie.domain || 'www.douyin.com').replace(/^\./, '');
      const protocol = cookie.secure ? 'https' : 'http';
      return ses.cookies.remove(`${protocol}://${domain}${cookie.path || '/'}`, cookie.name).catch(() => undefined);
    }));
}

async function clearDouyinRefreshCookies(): Promise<void> {
  await clearDouyinCookiesByName(DOUYIN_REFRESH_COOKIE_NAMES);
}

function isAllowedDouyinNavigation(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && (host === 'douyin.com' || host.endsWith('.douyin.com'));
  } catch {
    return false;
  }
}

// Open a visible, isolated Douyin window only after an explicit renderer action.
// Opening Douyin's sign-in panel renews additional guest verification state even
// when the user does not enter an account. Passwords never cross IPC.
function openDouyinLoginWindow(parent: BrowserWindow | null): Promise<boolean> {
  if (douyinLoginPromise) {
    if (douyinLoginWindow && !douyinLoginWindow.isDestroyed()) {
      douyinLoginWindow.show();
      douyinLoginWindow.focus();
    }
    return douyinLoginPromise;
  }

  douyinLoginPromise = new Promise<boolean>((resolve) => {
    const ses = session.fromPartition(DOUYIN_PARTITION);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const loginWindow = new BrowserWindow({
      parent: parent ?? undefined,
      modal: Boolean(parent),
      show: false,
      width: 1100,
      height: 780,
      minWidth: 820,
      minHeight: 620,
      title: 'Làm mới phiên Douyin',
      autoHideMenuBar: true,
      webPreferences: {
        partition: DOUYIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    douyinLoginWindow = loginWindow;
    loginWindow.removeMenu();
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    loginWindow.webContents.on('will-navigate', (event, target) => {
      if (!isAllowedDouyinNavigation(target)) event.preventDefault();
    });

    let settled = false;
    let accessFailed = false;
    let gatewayRetries = 0;
    let closeAfterFailure: NodeJS.Timeout | null = null;
    const loadTimeout = setTimeout(() => {
      accessFailed = true;
      if (!loginWindow.isDestroyed()) loginWindow.close();
    }, 20000);

    loginWindow.webContents.on('did-finish-load', async () => {
      if (loginWindow.isDestroyed()) return;
      const gatewayFailure = await loginWindow.webContents.executeJavaScript(`(() => {
        const title = document.title || '';
        const text = (document.body?.innerText || '').slice(0, 500);
        return /\\b50[234]\\b|gateway\\s*time-?out|bad\\s*gateway|service\\s*unavailable/i.test(title + '\\n' + text);
      })()`, true).catch(() => false);

      if (!gatewayFailure) {
        clearTimeout(loadTimeout);
        loginWindow.show();
        return;
      }
      if (gatewayRetries < 1) {
        gatewayRetries += 1;
        setTimeout(() => {
          if (!loginWindow.isDestroyed()) loginWindow.reload();
        }, 700);
        return;
      }

      await loginWindow.webContents.executeJavaScript(`(() => {
        document.title = 'Douyin tạm thời không phản hồi';
        document.body.innerHTML = '<main style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:32px;color:#202020"><h1 style="font-size:24px;margin:0 0 14px">Douyin tạm thời không phản hồi</h1><p style="font-size:15px;line-height:1.6;color:#666">Ứng dụng sẽ đóng cửa sổ này. Vui lòng thử lại sau.</p></main>';
      })()`, true).catch(() => undefined);
      accessFailed = true;
      loginWindow.show();
      closeAfterFailure = setTimeout(() => {
        if (!loginWindow.isDestroyed()) loginWindow.close();
      }, 3000);
    });

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimeout);
      if (closeAfterFailure) clearTimeout(closeAfterFailure);
      // On a normally loaded page, closing is the user's confirmation that they
      // opened Douyin's sign-in panel. The subsequent download validates whether
      // the refreshed guest state is sufficient; no account credentials required.
      resolve(!accessFailed);
      douyinLoginWindow = null;
      douyinLoginPromise = null;
    };

    loginWindow.once('closed', () => { void finish(); });
    loginWindow.loadURL('https://www.douyin.com/').catch(() => {
      accessFailed = true;
      if (!loginWindow.isDestroyed()) loginWindow.close();
    });
  });

  return douyinLoginPromise;
}

async function getTikTokCookies(): Promise<Cookie[]> {
  const ses = session.fromPartition(TIKTOK_PARTITION);
  return await ses.cookies.get({ domain: 'tiktok.com' });
}

function hasTikTokLogin(cookies: Cookie[]): boolean {
  return cookies.some((cookie) => TIKTOK_AUTH_COOKIE_NAMES.has(cookie.name) && cookieIsFresh(cookie));
}

async function writeTikTokCookies(filePath: string): Promise<boolean> {
  const cookies = await getTikTokCookies();
  if (!hasTikTokLogin(cookies)) return false;
  await fs.writeFile(filePath, toNetscapeCookies(cookies), { encoding: 'utf8', mode: 0o600 });
  return true;
}

async function clearTikTokAuthCookies(): Promise<void> {
  const ses = session.fromPartition(TIKTOK_PARTITION);
  const cookies = await getTikTokCookies().catch(() => []);
  await Promise.all(cookies
    .filter((cookie) => TIKTOK_AUTH_COOKIE_NAMES.has(cookie.name))
    .map((cookie) => {
      const domain = (cookie.domain || 'www.tiktok.com').replace(/^\./, '');
      const protocol = cookie.secure ? 'https' : 'http';
      return ses.cookies.remove(`${protocol}://${domain}${cookie.path || '/'}`, cookie.name).catch(() => undefined);
    }));
}

function isAllowedTikTokNavigation(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && (host === 'tiktok.com' || host.endsWith('.tiktok.com'));
  } catch {
    return false;
  }
}

function isAllowedTikTokAuthNavigation(raw: string): boolean {
  if (raw === 'about:blank') return true;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (url.protocol !== 'https:') return false;
    return [
      'tiktok.com',
      'facebook.com',
      'facebook.net',
      'fb.com',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

// TikTok may withhold the media stream for account-gated short dramas. Open a
// dedicated sign-in window only after the renderer receives explicit consent.
function openTikTokLoginWindow(parent: BrowserWindow | null): Promise<boolean> {
  if (tiktokLoginPromise) {
    if (tiktokLoginWindow && !tiktokLoginWindow.isDestroyed()) {
      tiktokLoginWindow.show();
      tiktokLoginWindow.focus();
    }
    return tiktokLoginPromise;
  }

  tiktokLoginPromise = new Promise<boolean>((resolve) => {
    const ses = session.fromPartition(TIKTOK_PARTITION);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const loginWindow = new BrowserWindow({
      parent: parent ?? undefined,
      modal: Boolean(parent),
      show: false,
      width: 1100,
      height: 780,
      minWidth: 820,
      minHeight: 620,
      title: 'Đăng nhập TikTok',
      autoHideMenuBar: true,
      webPreferences: {
        partition: TIKTOK_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    tiktokLoginWindow = loginWindow;
    const authPopups = new Set<BrowserWindow>();
    loginWindow.removeMenu();
    loginWindow.webContents.setWindowOpenHandler((details) => {
      if (!isAllowedTikTokAuthNavigation(details.url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: loginWindow,
          modal: true,
          width: 620,
          height: 760,
          minWidth: 480,
          minHeight: 600,
          title: 'Xác nhận đăng nhập TikTok',
          autoHideMenuBar: true,
          webPreferences: {
            partition: TIKTOK_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    });
    loginWindow.webContents.on('did-create-window', (popup) => {
      authPopups.add(popup);
      popup.removeMenu();
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guardNavigation = (event: Electron.Event, target: string) => {
        if (!isAllowedTikTokAuthNavigation(target)) event.preventDefault();
      };
      popup.webContents.on('will-navigate', guardNavigation);
      popup.webContents.on('will-redirect', guardNavigation);
      popup.once('closed', () => authPopups.delete(popup));
    });
    loginWindow.webContents.on('will-navigate', (event, target) => {
      if (!isAllowedTikTokNavigation(target)) event.preventDefault();
    });
    loginWindow.webContents.on('will-redirect', (event, target) => {
      if (!isAllowedTikTokNavigation(target)) event.preventDefault();
    });

    let authenticated = false;
    let settled = false;
    const poll = setInterval(async () => {
      const cookies = await getTikTokCookies().catch(() => []);
      if (!hasTikTokLogin(cookies)) return;
      authenticated = true;
      clearInterval(poll);
      setTimeout(() => {
        if (!loginWindow.isDestroyed()) loginWindow.close();
      }, 1200);
    }, 750);

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      for (const popup of authPopups) {
        if (!popup.isDestroyed()) popup.close();
      }
      authPopups.clear();
      const cookies = await getTikTokCookies().catch(() => []);
      resolve(authenticated || hasTikTokLogin(cookies));
      tiktokLoginWindow = null;
      tiktokLoginPromise = null;
    };

    loginWindow.once('ready-to-show', () => loginWindow.show());
    loginWindow.once('closed', () => { void finish(); });
    loginWindow.loadURL('https://www.tiktok.com/login').catch(() => {
      if (!loginWindow.isDestroyed()) loginWindow.close();
    });
  });

  return tiktokLoginPromise;
}

class DownloadAttemptError extends Error {
  constructor(readonly kind: 'session' | 'generic') {
    super('DOWNLOAD_ATTEMPT_FAILED');
  }
}

function classifyDouyinFailure(stderr: string): 'session' | 'generic' {
  return /fresh cookies|failed to parse json|sign in|log[ -]?in|verification|captcha|http error (?:403|429)/i.test(stderr)
    ? 'session'
    : 'generic';
}

function classifyTikTokFailure(stderr: string): 'session' | 'generic' {
  return /universal data for rehydration|no video formats found|sign in|log[ -]?in|verification|captcha|http error (?:403|429)/i.test(stderr)
    ? 'session'
    : 'generic';
}

// YouTube extraction now requires a JS runtime to solve its player challenge.
// We bundle Deno so it works offline without the user installing anything.
function denoBinary(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'deno')
    : path.join(app.getAppPath(), 'resources', 'deno');
  return path.join(base, process.platform === 'win32' ? 'deno.exe' : 'deno');
}

export function registerYtdlpIpc(): void {
  ipcMain.handle('ytdlp:download', async (e, args: YtdlpDownloadArgs): Promise<string> => {
    const { projectId, url } = args;
    if (!projectId || !url) throw new Error('Thiếu thông tin cần thiết để tải video.');

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('URL không hợp lệ.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Chỉ hỗ trợ URL http/https.');
    }

    const sourceUrl = normalizeSourceUrl(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const isDouyin = host === 'douyin.com' || host.endsWith('.douyin.com');
    const isTikTok = host === 'tiktok.com' || host.endsWith('.tiktok.com');

    const binary = ytdlpBinary();
    try {
      await fs.access(binary);
    } catch {
      throw new Error('Không thể khởi tạo bộ tải video. Vui lòng cài lại ứng dụng.');
    }

    const win = BrowserWindow.fromWebContents(e.sender);
    const sourceDir = path.join(projectDir(projectId), 'source');
    await fs.mkdir(sourceDir, { recursive: true });
    const outTemplate = path.join(sourceDir, 'source-%(id)s.%(ext)s');
    const ffmpegDir = path.dirname(ffmpegBinary());

    const ytArgs = [
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegDir,
      '--ignore-config',
      '--no-plugin-dirs',
      '--no-playlist',
      '--newline',
      '-o', outTemplate,
      '--print', 'after_move:filepath',
    ];
    if (isDouyin || isTikTok) {
      // Match a normal browser request so access checks fail fast instead of
      // leaving the extractor waiting at 0% for tens of seconds.
      ytArgs.push('--impersonate', 'chrome', '--socket-timeout', '10', '--extractor-retries', '1');
    }

    // YouTube extraction now needs a JS runtime to solve its player challenge.
    // We bundle Deno and expose it via PATH rather than `--js-runtimes deno:<path>`,
    // because a Windows path (C:\…) contains a colon that yt-dlp misparses as the
    // runtime/path separator. Prepending the deno dir to PATH lets the bare
    // `--js-runtimes deno` resolve it. Skip if missing (non-YouTube sources still work).
    const deno = denoBinary();
    const childEnv = { ...process.env };
    if (await fs.access(deno).then(() => true).catch(() => false)) {
      ytArgs.push('--js-runtimes', 'deno');
      // Windows exposes PATH as `Path`; reuse the existing key (any case) so we
      // don't leave two conflicting entries the child might read inconsistently.
      const pathKey = Object.keys(childEnv).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      childEnv[pathKey] = `${path.dirname(deno)}${path.delimiter}${childEnv[pathKey] ?? ''}`;
    }

    const emit = (p: YtdlpProgress) => win?.webContents.send('ytdlp:progress', p);

    // Run the downloader once with an optional short-lived cookie file. Raw child
    // output never crosses IPC; only a coarse internal failure category is kept.
    const runOnce = (cookiesFile: string | null): Promise<string> => {
      const runArgs = [...ytArgs];
      if (cookiesFile) runArgs.push('--cookies', cookiesFile);
      runArgs.push(sourceUrl);

      const child = spawn(binary, runArgs, { cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });

      return new Promise<string>((resolve, reject) => {
        let stderr = '';
        let finalPath = '';
        let stdoutBuffer = '';

        emit({ projectId, percent: 0, phase: 'preparing' });

        child.stdout?.on('data', (data) => {
          stdoutBuffer += String(data);
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            const dl = trimmed.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
            if (dl) {
              emit({ projectId, percent: Math.min(100, parseFloat(dl[1])), phase: 'downloading' });
            } else if (/\[Merger\]/.test(trimmed)) {
              emit({ projectId, percent: 100, phase: 'merging' });
            } else if (trimmed && !trimmed.startsWith('[')) {
              // With --print after_move:filepath the resolved path is printed bare.
              if (path.isAbsolute(trimmed)) finalPath = trimmed;
            }
          }
        });

        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.on('error', () => reject(new DownloadAttemptError('generic')));
        child.on('close', async (code) => {
          if (code !== 0) {
            const kind = isDouyin
              ? classifyDouyinFailure(stderr)
              : isTikTok
                ? classifyTikTokFailure(stderr)
                : 'generic';
            reject(new DownloadAttemptError(kind));
            return;
          }
          // Fall back to scanning the source dir if --print gave nothing usable.
          if (!finalPath || !(await fs.access(finalPath).then(() => true).catch(() => false))) {
            const entries = await fs.readdir(sourceDir).catch(() => [] as string[]);
            const candidates = await Promise.all(entries
              .filter((name) => name.startsWith('source-'))
              .map(async (name) => {
                const full = path.join(sourceDir, name);
                return { full, mtimeMs: (await fs.stat(full)).mtimeMs };
              }));
            finalPath = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.full ?? '';
          }
          if (!finalPath) {
            reject(new Error('Đã tải xong nhưng không thể hoàn thiện tệp video. Vui lòng thử lại.'));
            return;
          }
          emit({ projectId, percent: 100, phase: 'complete' });
          resolve(finalPath);
        });
      });
    };

    if (isTikTok) {
      // Public videos still use the ordinary path. Account-gated videos retry
      // with the isolated TikTok session when one is available; otherwise the UI
      // offers an explicit sign-in instead of touching the primary browser.
      const cookiesFile = tiktokCookiesPath();
      try {
        const hasSession = await writeTikTokCookies(cookiesFile).catch(() => false);
        try {
          return await runOnce(hasSession ? cookiesFile : null);
        } catch (error) {
          if (error instanceof DownloadAttemptError && error.kind === 'session') {
            throw new Error(TIKTOK_LOGIN_REQUIRED);
          }
          throw new Error('Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.');
        }
      } finally {
        await fs.unlink(cookiesFile).catch(() => undefined);
      }
    }

    if (!isDouyin) {
      try {
        return await runOnce(null);
      } catch {
        throw new Error('Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.');
      }
    }

    // Always export the current isolated session into a unique temporary file.
    // If Douyin rejects it, renew only the verification cookies and retry once.
    // A second session rejection asks the renderer to offer an explicit login.
    const cookiesFile = douyinCookiesPath();
    await fs.unlink(legacyDouyinCookiesPath()).catch(() => undefined);
    try {
      const hadUsableSession = hasRequiredDouyinCookies(await getDouyinCookies().catch(() => []));
      if (!(await harvestDouyinCookies(cookiesFile))) throw new Error(DOUYIN_LOGIN_REQUIRED);
      try {
        return await runOnce(cookiesFile);
      } catch (error) {
        if (!(error instanceof DownloadAttemptError) || error.kind !== 'session') {
          throw new Error('Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.');
        }
        // Immediately after the user clears the session, `harvest` has already
        // produced a fresh guest state. If Douyin still rejects it, repeating the
        // same slow request cannot help; ask for explicit sign-in right away.
        if (!hadUsableSession) throw new Error(DOUYIN_LOGIN_REQUIRED);
      }

      await clearDouyinRefreshCookies();
      if (!(await harvestDouyinCookies(cookiesFile))) throw new Error(DOUYIN_LOGIN_REQUIRED);
      try {
        return await runOnce(cookiesFile);
      } catch (error) {
        if (error instanceof DownloadAttemptError && error.kind === 'session') {
          throw new Error(DOUYIN_LOGIN_REQUIRED);
        }
        throw new Error('Không thể tải video từ liên kết này. Hãy kiểm tra liên kết hoặc thử lại sau.');
      }
    } finally {
      await fs.unlink(cookiesFile).catch(() => undefined);
    }
  });

  ipcMain.handle('ytdlp:douyinLogin', async (e): Promise<boolean> => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    // Preserve the existing guest state so the page itself remains reachable.
    // Opening its sign-in panel adds/renews the remaining verification cookies.
    return await openDouyinLoginWindow(parent);
  });

  ipcMain.handle('ytdlp:douyinClearSession', async (): Promise<void> => {
    if (douyinLoginWindow && !douyinLoginWindow.isDestroyed()) douyinLoginWindow.close();
    const ses = session.fromPartition(DOUYIN_PARTITION);
    await ses.clearStorageData();
    await fs.unlink(legacyDouyinCookiesPath()).catch(() => undefined);
  });

  ipcMain.handle('ytdlp:tiktokLogin', async (e): Promise<boolean> => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    if (!tiktokLoginPromise) await clearTikTokAuthCookies();
    return await openTikTokLoginWindow(parent);
  });

  ipcMain.handle('ytdlp:tiktokClearSession', async (): Promise<void> => {
    if (tiktokLoginWindow && !tiktokLoginWindow.isDestroyed()) tiktokLoginWindow.close();
    const ses = session.fromPartition(TIKTOK_PARTITION);
    await ses.clearStorageData();
  });

  // Let the user pick a local video/audio file and copy it into <project>/source/.
  // Returns the copied absolute path, or null when cancelled.
  ipcMain.handle('ytdlp:import', async (e, projectId: string): Promise<string | null> => {
    if (!projectId) throw new Error('Thiếu thông tin cần thiết để nhập tệp.');
    const win = BrowserWindow.fromWebContents(e.sender);

    const picked = await dialog.showOpenDialog(win!, {
      title: 'Chọn video hoặc audio nguồn',
      properties: ['openFile'],
      filters: [{ name: 'Video/Audio', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const source = picked.filePaths[0];
    const ext = (path.extname(source).replace('.', '').toLowerCase() || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
    const sourceDir = path.join(projectDir(projectId), 'source');
    await fs.mkdir(sourceDir, { recursive: true });

    const dest = path.join(sourceDir, `source-${Date.now()}.${ext}`);
    await fs.copyFile(source, dest);
    return dest;
  });

  ipcMain.handle('ytdlp:importMany', async (e, projectId: string): Promise<string[]> => {
    if (!projectId) throw new Error('Thiếu thông tin cần thiết để nhập tệp.');
    const win = BrowserWindow.fromWebContents(e.sender);
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Chọn nhiều video hoặc audio nguồn',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video/Audio', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return [];

    const sourceDir = path.join(projectDir(projectId), 'source');
    await fs.mkdir(sourceDir, { recursive: true });
    return await Promise.all(picked.filePaths.map(async (source, index) => {
      const ext = (path.extname(source).replace('.', '').toLowerCase() || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
      const originalName = path.basename(source, path.extname(source)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || `video-${index + 1}`;
      const dest = path.join(sourceDir, `${originalName}-${Date.now()}-${index}.${ext}`);
      await fs.copyFile(source, dest);
      return dest;
    }));
  });
}
