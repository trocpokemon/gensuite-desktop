import { ipcMain, BrowserWindow, app, dialog } from 'electron';
import { spawn } from 'node:child_process';
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
      url,
    ];

    const child = spawn(binary, ytArgs, { cwd: sourceDir, stdio: ['ignore', 'pipe', 'pipe'] });

    return await new Promise<string>((resolve, reject) => {
      let stderr = '';
      let finalPath = '';
      let stdoutBuffer = '';

      const emit = (p: YtdlpProgress) => win?.webContents.send('ytdlp:progress', p);
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
