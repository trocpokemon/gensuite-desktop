import { ipcMain, app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSettings, TopicConfig } from '../../src/shared/types';

const settingsPath = (): string =>
  path.join(app.getPath('userData'), 'GenSuite', 'settings.json');
const topicsPath = (): string =>
  path.join(app.getPath('userData'), 'GenSuite', 'topics.json');

const DEFAULT_SETTINGS: AppSettings = {
  googleApiKey: '',
  pexelsApiKey: '',
  pixabayApiKey: '',
  unsplashApiKey: '',
  gensuiteApiKey: '',
};

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(next: AppSettings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf-8');
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:load', async (): Promise<AppSettings> => {
    return readSettings();
  });

  ipcMain.handle('settings:save', async (_e, next: AppSettings): Promise<void> => {
    const merged = { ...DEFAULT_SETTINGS, ...next };
    await writeSettings(merged);
  });

  ipcMain.handle('topics:load', async (): Promise<TopicConfig[]> => {
    try {
      return JSON.parse(await fs.readFile(topicsPath(), 'utf-8')) as TopicConfig[];
    } catch {
      return [];
    }
  });

  ipcMain.handle('topics:save', async (_e, topics: TopicConfig[]): Promise<void> => {
    const file = topicsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(topics, null, 2), 'utf-8');
  });
}
