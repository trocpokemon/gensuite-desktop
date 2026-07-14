import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { projectDir } from './project';
import type { EdgeTtsSynthesizeArgs, EdgeTtsVoice } from '../../src/shared/types';

// edge-tts calls Microsoft Edge's online Read-Aloud service over a WebSocket —
// free, no API key, but requires network. Node-only (the service now demands an
// Edge user-agent), so it runs here in the main process, not the renderer. Each
// job is tracked by id so the renderer can cancel a slow synthesis mid-run.

type Job = { tts: MsEdgeTTS };
const running = new Map<string, Job>();

// The SSML template inserts text verbatim, so user input must be XML-escaped to
// avoid breaking the document (or injecting extra SSML tags).
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// speed multiplier (1 = natural) → signed percentage string the service expects.
function ratePercent(speed?: number): string {
  const clamped = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const pct = Math.round((clamped - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

export function registerEdgeTtsIpc(): void {
  ipcMain.handle('edgetts:voices', async (): Promise<EdgeTtsVoice[]> => {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    return voices.map((voice) => ({
      shortName: voice.ShortName,
      friendlyName: voice.FriendlyName,
      locale: voice.Locale,
      gender: voice.Gender,
    }));
  });

  ipcMain.handle('edgetts:synthesize', async (_e, args: EdgeTtsSynthesizeArgs): Promise<string> => {
    const { projectId, jobId, segmentId, text, voiceId } = args;
    if (!projectId || !jobId || !text?.trim()) throw new Error('edgetts:synthesize missing args');
    if (!voiceId) throw new Error('Chưa chọn giọng edge-tts.');

    const audioDir = path.join(projectDir(projectId), 'audio');
    await fs.mkdir(audioDir, { recursive: true });
    const outPath = path.join(audioDir, `${segmentId}.mp3`);

    const tts = new MsEdgeTTS();
    running.set(jobId, { tts });

    try {
      await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const pitchHz = Math.round(Number(args.pitch) || 0);
      const volume = Math.max(0, Math.min(100, Number.isFinite(args.volume as number) ? Number(args.volume) : 100));
      const { audioStream } = tts.toStream(escapeXml(text), {
        rate: ratePercent(args.speed),
        pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
        volume,
      });

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        audioStream.on('close', resolve);
        audioStream.on('error', (err: Error) => {
          if (/turn\.end|Stream closed before the synthesis/i.test(err?.message ?? '')) {
            reject(new Error('Máy chủ Edge TTS ngắt kết nối giữa chừng nên audio bị cắt. Thường do bị giới hạn khi tạo nhiều đoạn liên tiếp — hãy chờ vài giây rồi bấm "Đọc" lại cho phân cảnh này.'));
            return;
          }
          reject(err);
        });
      });

      if (!running.has(jobId)) throw new Error('edgetts:killed');
      if (!chunks.length) throw new Error('edge-tts không trả về audio. Kiểm tra kết nối mạng và tên giọng.');

      await fs.writeFile(outPath, Buffer.concat(chunks));
      return outPath;
    } finally {
      tts.close();
      running.delete(jobId);
    }
  });

  ipcMain.handle('edgetts:kill', async (_e, jobId: string): Promise<boolean> => {
    const job = running.get(jobId);
    if (!job) return false;
    running.delete(jobId);
    job.tts.close();
    return true;
  });
}
