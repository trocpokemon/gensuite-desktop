import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';

type DownloadArgs = {
  projectId: string;
  url: string;
  sceneId: string;
  ext?: string;
};

// Download a chosen stock image into <project>/media/. Returns the local path.
export function registerMediaIpc(): void {
  ipcMain.handle('media:download', async (_e, args: DownloadArgs): Promise<string> => {
    const { projectId, url, sceneId } = args;
    if (!projectId || !url || !sceneId) throw new Error('media:download missing args');

    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported media url protocol');
    }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    const ext = (args.ext || guessExt(parsed.pathname, resp.headers.get('content-type'))).replace(/[^a-z0-9]/gi, '') || 'jpg';
    const mediaDir = path.join(projectDir(projectId), 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    const safeSceneId = sanitize(sceneId);
    // Every replacement gets a new path so Chromium cannot reuse the previous
    // image/video from its file cache. Remove older selections only after the
    // new response has been downloaded successfully into memory.
    const existing = await fs.readdir(mediaDir).catch(() => [] as string[]);
    await Promise.all(existing
      .filter((name) => name.startsWith(`${safeSceneId}.`) || name.startsWith(`${safeSceneId}-`))
      .map((name) => fs.unlink(path.join(mediaDir, name)).catch(() => undefined)));
    const dest = path.join(mediaDir, `${safeSceneId}-${Date.now()}.${ext}`);
    await fs.writeFile(dest, buf);
    return dest;
  });
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_');
}

function guessExt(pathname: string, contentType: string | null): string {
  const fromPath = path.extname(pathname).replace('.', '').toLowerCase();
  if (fromPath) return fromPath;
  if (contentType?.includes('video/mp4')) return 'mp4';
  if (contentType?.includes('video/webm')) return 'webm';
  if (contentType?.includes('video/quicktime')) return 'mov';
  if (contentType?.includes('png')) return 'png';
  if (contentType?.includes('webp')) return 'webp';
  return 'jpg';
}
