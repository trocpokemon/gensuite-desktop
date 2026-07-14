import { ipcMain, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import type { MusicImportResult } from '../../src/shared/types';

// Let the user pick an audio file from disk and copy it into <project>/music/.
// Returns the local path plus the original file name for display, or null when
// the picker is cancelled.
export function registerMusicIpc(): void {
  ipcMain.handle('music:import', async (e, projectId: string): Promise<MusicImportResult | null> => {
    if (!projectId) throw new Error('music:import missing projectId');
    const win = BrowserWindow.fromWebContents(e.sender);

    const picked = await dialog.showOpenDialog(win!, {
      title: 'Chọn nhạc nền',
      properties: ['openFile'],
      filters: [{ name: 'Âm thanh', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const source = picked.filePaths[0];
    const ext = (path.extname(source).replace('.', '').toLowerCase() || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
    const musicDir = path.join(projectDir(projectId), 'music');
    await fs.mkdir(musicDir, { recursive: true });

    // A fresh timestamped name each import so Chromium's file cache never serves
    // a stale track, and clear any previous imports so the dir holds just one.
    const existing = await fs.readdir(musicDir).catch(() => [] as string[]);
    await Promise.all(existing.map((name) => fs.unlink(path.join(musicDir, name)).catch(() => undefined)));

    const dest = path.join(musicDir, `track-${Date.now()}.${ext}`);
    await fs.copyFile(source, dest);
    return { audioPath: dest, fileName: path.basename(source) };
  });
}
