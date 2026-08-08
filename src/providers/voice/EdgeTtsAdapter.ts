import type { SubtitleWordTiming } from '../../shared/types';
import { clientAppError } from '../clientAppError';
import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';
import {
  createVoiceCheckpoint,
  loadVoiceCheckpoint,
  retryDelay,
  saveVoiceCheckpoint,
  splitVoiceText,
  voiceRequestKey,
} from './voiceReliability';

const MAX_FREE_VOICE_CHARS = 50_000;

// Free/keyless voice source. It still needs a network connection, so every
// request is split, checkpointed and validated before the scene is committed.
export class EdgeTtsAdapter implements IVoiceProvider {
  readonly engine = 'edgetts' as const;
  readonly isLocal = true;

  private jobId: string | null = null;
  private controller: AbortController | null = null;

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw clientAppError('VOICE_INPUT_INVALID');
    if (req.text.length > MAX_FREE_VOICE_CHARS) throw clientAppError('VOICE_TEXT_TOO_LONG');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const chunks = splitVoiceText(req.text, 900);
    const requestKey = voiceRequestKey(req, this.engine);
    const checkpoint = loadVoiceCheckpoint(req.projectId, req.segmentId, requestKey)
      ?? createVoiceCheckpoint(requestKey, chunks.length);
    if (checkpoint.parts.length !== chunks.length) checkpoint.parts = createVoiceCheckpoint(requestKey, chunks.length).parts;
    saveVoiceCheckpoint(req.projectId, req.segmentId, checkpoint);

    const partPaths: string[] = [];
    const wordTimings: SubtitleWordTiming[] = [];
    let offset = 0;
    const report = (completedChunks: number, phase: Parameters<NonNullable<VoiceRequest['onProgress']>>[0]['phase']) => {
      req.onProgress?.({ completedChunks, totalChunks: chunks.length, phase });
    };
    report(0, 'requesting');
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const part = checkpoint.parts[index];
        if (signal.aborted) throw clientAppError('VOICE_CANCELLED', { chunkNumber: index + 1, chunkCount: chunks.length });
        if (part.status === 'done' && part.audioPath) {
          const existing = await window.gensuite.audio.probe({ audioPath: part.audioPath });
          if (existing.ok) {
            const duration = existing.value.durationSec;
            for (const timing of part.wordTimings ?? []) {
              wordTimings.push({ word: timing.word, start: timing.start + offset, end: timing.end + offset });
            }
            offset += duration;
            partPaths.push(existing.value.audioPath);
            report(index + 1, 'requesting');
            continue;
          }
          part.status = 'pending';
          part.audioPath = undefined;
          part.durationSec = undefined;
          part.wordTimings = undefined;
        }

        let result: Awaited<ReturnType<typeof window.gensuite.edgetts.synthesize>> | null = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          report(index, 'requesting');
          const jobId = `${req.segmentId}_${requestKey}_${index + 1}_${Date.now()}`;
          this.jobId = jobId;
          result = await window.gensuite.edgetts.synthesize({
            projectId: req.projectId,
            jobId,
            segmentId: `${req.segmentId}-${requestKey}-${index + 1}`,
            text: chunks[index],
            voiceId: req.voiceId,
            speed: req.speed,
            pitch: req.pitch,
            volume: req.volume,
            chunkNumber: index + 1,
            chunkCount: chunks.length,
          });
          if (result.ok || !result.error.retryable || attempt === 3 || signal.aborted) break;
          await retryDelay(attempt, signal);
        }
        if (!result?.ok) throw result?.error ?? clientAppError('VOICE_UNEXPECTED', { chunkNumber: index + 1, chunkCount: chunks.length });
        part.status = 'done';
        part.audioPath = result.value.audioPath;
        part.durationSec = result.value.durationSec;
        part.wordTimings = result.value.wordTimings;
        checkpoint.createdAt = Date.now();
        saveVoiceCheckpoint(req.projectId, req.segmentId, checkpoint);
        for (const timing of result.value.wordTimings ?? []) {
          wordTimings.push({ word: timing.word, start: timing.start + offset, end: timing.end + offset });
        }
        offset += result.value.durationSec;
        partPaths.push(result.value.audioPath);
        report(index + 1, 'requesting');
      }

      report(chunks.length, 'assembling');
      const assembled = await window.gensuite.audio.assemble({ projectId: req.projectId, segmentId: req.segmentId, partPaths });
      if (!assembled.ok) throw assembled.error;
      report(chunks.length, 'completed');
      return {
        audioPath: assembled.value.audioPath,
        durationSec: assembled.value.durationSec,
        wordTimings: wordTimings.length ? wordTimings : undefined,
      };
    } finally {
      this.jobId = null;
      this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    if (this.jobId) window.gensuite.edgetts.kill(this.jobId).catch(() => undefined);
    this.jobId = null;
  }
}
