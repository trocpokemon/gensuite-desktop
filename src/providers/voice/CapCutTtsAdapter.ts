import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';
import { capCutVoiceById } from './capcutTtsCatalog';
import { clientAppError } from '../clientAppError';

export class CapCutTtsAdapter implements IVoiceProvider {
  readonly engine = 'capcuttts' as const;
  readonly isLocal = true;

  private jobId: string | null = null;

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw clientAppError('VOICE_INPUT_INVALID');
    const voice = capCutVoiceById(req.voiceId);
    if (!voice) throw clientAppError('VOICE_INPUT_INVALID');
    const jobId = `${req.segmentId}_${Date.now()}`;
    this.jobId = jobId;
    try {
      req.onProgress?.({ completedChunks: 0, totalChunks: 1, phase: 'requesting' });
      const response = await window.gensuite.capcuttts.synthesize({
        projectId: req.projectId,
        jobId,
        segmentId: req.segmentId,
        text: req.text,
        voiceId: voice.voiceId,
        resourceId: voice.resourceId,
        speed: req.speed,
      });
      if (!response.ok) throw response.error;
      const result = response.value;
      req.onProgress?.({ completedChunks: 1, totalChunks: 1, phase: 'completed' });
      return { audioPath: result.audioPath, durationSec: result.durationSec };
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
