import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';
import { localFileUrl } from '../../shared/localFile';

// Local-free mode: drives Microsoft Edge's online Read-Aloud service through the
// main process (window.gensuite.edgetts). Free and keyless, but needs network.
// The renderer can call cancel() to close the WebSocket mid-run; synthesize()
// then rejects with 'edgetts:killed'.
export class EdgeTtsAdapter implements IVoiceProvider {
  readonly engine = 'edgetts' as const;
  readonly isLocal = true;

  private jobId: string | null = null;

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw new Error('Đoạn văn trống.');

    const jobId = `${req.segmentId}_${Date.now()}`;
    this.jobId = jobId;

    let synthesis: Awaited<ReturnType<typeof window.gensuite.edgetts.synthesize>>;
    try {
      synthesis = await window.gensuite.edgetts.synthesize({
        projectId: req.projectId,
        jobId,
        segmentId: req.segmentId,
        text: req.text,
        voiceId: req.voiceId,
        speed: req.speed,
        pitch: req.pitch,
        volume: req.volume,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('edgetts:killed')) throw new Error('voice:cancelled');
      if (message.includes('ngắt kết nối giữa chừng')) {
        throw new Error('Kết nối tạo giọng bị gián đoạn. Hãy chờ vài giây rồi thử lại.');
      }
      throw new Error('Chưa thể tạo giọng lúc này. Hãy kiểm tra kết nối mạng hoặc thử lại sau.');
    } finally {
      if (this.jobId === jobId) this.jobId = null;
    }

    const durationSec = await probeFileDuration(synthesis.audioPath);
    return { audioPath: synthesis.audioPath, durationSec, wordTimings: synthesis.wordTimings };
  }

  cancel(): void {
    if (this.jobId) {
      window.gensuite.edgetts.kill(this.jobId).catch(() => {});
      this.jobId = null;
    }
  }
}

// edge-tts writes an MP3 to disk; load it through an <audio> element to read length.
function probeFileDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio();
    el.addEventListener('loadedmetadata', () =>
      resolve(Number.isFinite(el.duration) ? el.duration : 0),
    );
    el.addEventListener('error', () => resolve(0));
    el.src = localFileUrl(audioPath) ?? '';
  });
}
