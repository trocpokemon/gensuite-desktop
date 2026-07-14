import { ipcMain, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import type { CharacterImportResult } from '../../src/shared/types';

// Let the user pick a character reference image from disk and copy it into
// <project>/characters/. Returns the local path, or null when cancelled. These
// references are reused across AI image scenes to keep a recurring character
// visually consistent (sent to the GenSuite image API as reference images).
export function registerCharacterIpc(): void {
  ipcMain.handle('characters:import', async (e, projectId: string): Promise<CharacterImportResult | null> => {
    if (!projectId) throw new Error('characters:import missing projectId');
    const win = BrowserWindow.fromWebContents(e.sender);

    const picked = await dialog.showOpenDialog(win!, {
      title: 'Chọn ảnh nhân vật',
      properties: ['openFile'],
      filters: [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const source = picked.filePaths[0];
    const ext = (path.extname(source).replace('.', '').toLowerCase() || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const charDir = path.join(projectDir(projectId), 'characters');
    await fs.mkdir(charDir, { recursive: true });

    const dest = path.join(charDir, `char-${Date.now()}.${ext}`);
    await fs.copyFile(source, dest);
    return { imagePath: dest };
  });
}
