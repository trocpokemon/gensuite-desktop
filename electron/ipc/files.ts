import { BrowserWindow, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PickTextResult, SaveCopyArgs, SaveTextArgs } from '../../src/shared/types';

function safeDefaultName(value: string, fallback: string): string {
  const name = path.basename(value || fallback).replace(/[<>:"/\\|?*]/g, '_');
  return name || fallback;
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:pickText', async (event): Promise<PickTextResult | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Chọn văn bản hoặc phụ đề',
      properties: ['openFile'],
      filters: [{ name: 'Văn bản / Phụ đề', extensions: ['txt', 'srt'] }],
    });
    const filePath = picked.filePaths[0];
    if (picked.canceled || !filePath) return null;
    return { name: path.basename(filePath), content: await fs.readFile(filePath, 'utf8') };
  });

  ipcMain.handle('files:saveText', async (event, args: SaveTextArgs): Promise<string | null> => {
    if (!args || typeof args.content !== 'string') throw new Error('Nội dung cần lưu không hợp lệ.');
    const extensions = (args.extensions || []).map((ext) => ext.replace(/^\./, '')).filter(Boolean);
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showSaveDialog(win!, {
      title: 'Lưu tệp',
      defaultPath: safeDefaultName(args.defaultName, 'gensuite.txt'),
      filters: extensions.length ? [{ name: 'Tệp đầu ra', extensions }] : undefined,
    });
    if (picked.canceled || !picked.filePath) return null;
    await fs.writeFile(picked.filePath, args.content, 'utf8');
    return picked.filePath;
  });

  ipcMain.handle('files:saveCopy', async (event, args: SaveCopyArgs): Promise<string | null> => {
    if (!args?.sourcePath) throw new Error('Không tìm thấy tệp nguồn.');
    await fs.access(args.sourcePath);
    const ext = path.extname(args.sourcePath).replace(/^\./, '') || 'bin';
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showSaveDialog(win!, {
      title: 'Lưu tệp',
      defaultPath: safeDefaultName(args.defaultName || path.basename(args.sourcePath), `gensuite.${ext}`),
      filters: [{ name: 'Tệp đầu ra', extensions: [ext] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    await fs.copyFile(args.sourcePath, picked.filePath);
    return picked.filePath;
  });
}
