import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';
import { localFileUrl } from '../../shared/localFile';
import { CAPCUT_TTS_VOICES, capCutVoiceById } from './capcutTtsCatalog';

export class CapCutTtsAdapter implements IVoiceProvider {
  readonly engine = 'capcuttts' as const;
  readonly isLocal = true;

  private jobId: string | null = null;

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw new Error('Đoạn văn trống.');
    const voice = capCutVoiceById(req.voiceId) ?? CAPCUT_TTS_VOICES[0];
    const jobId = `${req.segmentId}_${Date.now()}`;
    this.jobId = jobId;
    try {
      const result = await window.gensuite.capcuttts.synthesize({
        projectId: req.projectId,
        jobId,
        segmentId: req.segmentId,
        text: req.text,
        voiceId: voice.voiceId,
        resourceId: voice.resourceId,
        speed: req.speed,
      });
      return { audioPath: result.audioPath, durationSec: await probeFileDuration(result.audioPath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('voice:cancelled')) throw new Error('voice:cancelled');
      if (message.includes('Đoạn văn quá dài')) throw new Error('Đoạn văn quá dài. Hãy chia thành các đoạn ngắn hơn rồi thử lại.');
      if (message.includes('mất nhiều thời gian hơn dự kiến')) throw new Error('Tạo giọng mất nhiều thời gian hơn dự kiến. Hãy thử lại sau ít phút.');
      throw new Error('Chưa thể tạo giọng lúc này. Hãy kiểm tra kết nối mạng hoặc thử lại sau.');
    } finally {
      if (this.jobId === jobId) this.jobId = null;
    }
  }

  cancel(): void {
    if (!this.jobId) return;
    window.gensuite.capcuttts.kill(this.jobId).catch(() => {});
    this.jobId = null;
  }
}

function probeFileDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.addEventListener('loadedmetadata', () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
    audio.addEventListener('error', () => resolve(0), { once: true });
    audio.src = localFileUrl(audioPath) ?? '';
  });
}
