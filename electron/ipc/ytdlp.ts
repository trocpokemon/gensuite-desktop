import { ipcMain, BrowserWindow, app, dialog, session } from 'electron';
import type { Cookie } from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
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

// Chrome v127+ seals cookies with App-Bound Encryption that yt-dlp's DPAPI path
// can't unseal (issue #10927), so `--cookies-from-browser` is unreliable. Instead
// we load Douyin inside a hidden Electron window on a persistent partition: Douyin
// sets guest cookies (notably `ttwid`) on the first page load — no login needed —
// which we read straight from that session (no OS-level decryption) and write as a
// Netscape cookies.txt that yt-dlp reads via `--cookies`. The partition persists so
// the cookies survive across runs and we only re-harvest when they're missing/stale.
const DOUYIN_PARTITION = 'persist:douyin';

function douyinCookiesPath(): string {
  return path.join(app.getPath('userData'), 'douyin-cookies.txt');
}

// Serialize Electron cookies into the Netscape cookies.txt format yt-dlp expects:
//   domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
function toNetscapeCookies(cookies: Cookie[]): string {
  const lines = ['# Netscape HTTP Cookie File', ''];
  for (const c of cookies) {
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

// Read the guest cookies from the persistent Douyin session and write cookies.txt.
// Returns how many cookies were written.
async function writeDouyinCookies(): Promise<number> {
  const ses = session.fromPartition(DOUYIN_PARTITION);
  const cookies = await ses.cookies.get({ domain: 'douyin.com' });
  await fs.writeFile(douyinCookiesPath(), toNetscapeCookies(cookies), 'utf8');
  return cookies.length;
}

// Silently load Douyin in a hidden window so it sets its guest cookies, then
// harvest them into cookies.txt. No login and no user interaction needed — the
// `ttwid` cookie that unblocks yt-dlp is set on the first page load. Resolves with
// the cookie count once `ttwid` appears (or after a timeout, using whatever's set).
function harvestDouyinCookies(): Promise<number> {
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
      let count = 0;
      try { count = await writeDouyinCookies(); } catch { /* keep any prior file */ }
      if (!bgWin.isDestroyed()) bgWin.destroy();
      resolve(count);
    };

    // Poll the session cookies; resolve as soon as the bot-check `ttwid` is present.
    const ses = session.fromPartition(DOUYIN_PARTITION);
    const poll = setInterval(async () => {
      const cookies = await ses.cookies.get({ domain: 'douyin.com' }).catch(() => []);
      if (cookies.some((c) => c.name === 'ttwid')) { clearInterval(poll); await finish(); }
    }, 500);

    // Hard cap: don't hang the download if Douyin never sets ttwid. Harvest whatever
    // cookies exist and let yt-dlp try — the download step surfaces any real failure.
    const timer = setTimeout(async () => { clearInterval(poll); await finish(); }, 15000);

    bgWin.loadURL('https://www.douyin.com/').catch(() => { /* poll/timeout still fire */ });
  });
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
    if (!projectId || !url) throw new Error('ytdlp:download missing args');

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

    const binary = ytdlpBinary();
    try {
      await fs.access(binary);
    } catch {
      throw new Error('Không tìm thấy yt-dlp. Kiểm tra resources/ytdlp/.');
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
      '--no-playlist',
      '--newline',
      '-o', outTemplate,
      '--print', 'after_move:filepath',
    ];

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

    // Run yt-dlp once, optionally pointing it at a Netscape cookies.txt file.
    // Resolves to the downloaded file path, or rejects with the raw yt-dlp error.
    const runOnce = (cookiesFile: string | null): Promise<string> => {
      const runArgs = [...ytArgs];
      if (cookiesFile) runArgs.push('--cookies', cookiesFile);
      runArgs.push(sourceUrl);

      const child = spawn(binary, runArgs, { cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });

      return new Promise<string>((resolve, reject) => {
        let stderr = '';
        let finalPath = '';
        let stdoutBuffer = '';

        emit({ projectId, percent: 0, phase: 'downloading' });

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
        child.on('error', (err) => reject(new Error(`Không thể chạy yt-dlp: ${err.message}`)));
        child.on('close', async (code) => {
          if (code !== 0) {
            reject(new Error(`yt-dlp lỗi ${code}: ${stderr.slice(-400)}`));
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
            reject(new Error('yt-dlp tải xong nhưng không tìm thấy file nguồn.'));
            return;
          }
          emit({ projectId, percent: 100, phase: 'complete' });
          resolve(finalPath);
        });
      });
    };

    // Douyin rejects cookieless requests ("Fresh cookies … are needed"). Its guest
    // `ttwid` cookie is enough to unblock downloads, and it's set on the first page
    // load — no login needed — so we harvest it silently in a hidden window. Reuse
    // the persisted cookies.txt if present; otherwise harvest before downloading.
    const host = parsed.hostname.replace(/^www\./, '');
    const needsCookies = host === 'douyin.com' || host.endsWith('.douyin.com');
    if (!needsCookies) return await runOnce(null);

    const cookiesFile = douyinCookiesPath();
    if (!(await fs.access(cookiesFile).then(() => true).catch(() => false))) {
      await harvestDouyinCookies();
    }
    return await runOnce(cookiesFile);
  });

  // Let the user pick a local video/audio file and copy it into <project>/source/.
  // Returns the copied absolute path, or null when cancelled.
  ipcMain.handle('ytdlp:import', async (e, projectId: string): Promise<string | null> => {
    if (!projectId) throw new Error('ytdlp:import missing projectId');
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
}
