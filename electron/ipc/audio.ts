import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import type { AudioDownloadArgs, AudioWriteArgs } from '../../src/shared/types';

// Persist audio bytes produced by a voice adapter (returned as a Blob in the
// renderer, base64-encoded over IPC) into <project>/audio/. Both the local
// Kokoro adapter and the cloud adapters write here, so the timeline step treats
// every engine's audio identically.
export function registerAudioIpc(): void {
  ipcMain.handle('audio:write', async (_e, args: AudioWriteArgs): Promise<string> => {
    const { projectId, segmentId, base64 } = args;
    if (!projectId || !segmentId || !base64) throw new Error('audio:write missing args');

    const ext = (args.ext || 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
    const audioDir = path.join(projectDir(projectId), 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    const dest = path.join(audioDir, `${sanitize(segmentId)}.${ext}`);
    await fs.writeFile(dest, Buffer.from(base64, 'base64'));
    return dest;
  });

  // Download signed GenSuite audio in the main process. The provider/storage
  // URL may not expose CORS headers, so renderer-side fetch can fail even though
  // the TTS job completed successfully.
  ipcMain.handle('audio:download', async (_e, args: AudioDownloadArgs): Promise<string> => {
    const { projectId, segmentId, url } = args;
    if (!projectId || !segmentId || !url) throw new Error('audio:download missing args');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Audio URL không hợp lệ.');

    const response = await fetch(parsed, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Không tải được audio GenSuite (${response.status} ${response.statusText}).`);
    const contentType = String(response.headers.get('content-type') || args.format || '').toLowerCase();
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' : 'mp3';
    const audioDir = path.join(projectDir(projectId), 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    const dest = path.join(audioDir, `${sanitize(segmentId)}.${ext}`);
    await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
    return dest;
  });
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_');
}
