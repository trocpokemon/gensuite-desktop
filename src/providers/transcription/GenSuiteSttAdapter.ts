import type { ITranscriptionProvider, TranscribeRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { localFileUrl } from '../../shared/localFile';
import { gensuiteFetch } from '../../lib/gensuiteAuth';
import type { GenSuiteFeature } from '../../lib/gensuiteAuth';
import { isPublicAppError } from '../../shared/appErrors';
import { clientAppError } from '../clientAppError';

// GenSuite paid speech-to-text. Audio is extracted to a 16kHz mono WAV in the
// main process (shared with the local engine — this matches /v1/stt's required
// WAV LINEAR16 16kHz mono format). The renderer fetches that WAV as a Blob, POSTs
// it as multipart, then polls the async job until it finishes. The API returns a
// flat transcript plus word-level timestamps, which we group into timed segments.
const BASE_URL = 'https://api.gensuite.site/v1';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

// Grouping heuristics for turning word timestamps into subtitle-sized segments.
const SENTENCE_END = /[.!?。！？…]$/;
const MAX_SEGMENT_CHARS = 90;
const MAX_SEGMENT_GAP_SEC = 0.8;

interface SttWord {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
  startTime?: number;
  endTime?: number;
}

export class GenSuiteSttAdapter implements ITranscriptionProvider {
  readonly engine = 'cloud' as const;
  readonly isLocal = false;
  private controller: AbortController | null = null;
  private jobId = '';

  constructor(private feature?: GenSuiteFeature) {}

  private async requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
    const parentSignal = this.controller?.signal;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await gensuiteFetch(url, { ...init, signal: controller.signal }, this.feature);
      const text = await response.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) throw sttFailure(response.status, String(data?.error || ''));
      if (!data || typeof data !== 'object') throw clientAppError('TRANSCRIPTION_RESULT_INVALID');
      return data;
    } catch (error) {
      if (parentSignal?.aborted) throw clientAppError('TRANSCRIPTION_CANCELLED');
      if (timedOut) throw clientAppError('TRANSCRIPTION_REQUEST_TIMEOUT');
      if (isPublicAppError(error) || String(error).includes('AUTH_REQUIRED:gensuite') || String(error).includes('UPGRADE_REQUIRED')) throw error;
      throw clientAppError('TRANSCRIPTION_SERVICE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    }
  }

  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment[]> {
    this.controller = new AbortController();
    try {
      const extracted = await window.gensuite.whisper.extract({
        projectId: req.projectId,
        sourcePath: req.sourcePath,
      });
      if (!extracted.ok) throw extracted.error;

      const url = localFileUrl(extracted.value);
      if (!url) throw clientAppError('TRANSCRIPTION_SOURCE_UNREADABLE');
      const blob = await this.loadSourceBlob(url);
      const durationSeconds = await probeBlobDuration(blob);
      if (!(durationSeconds > 0)) throw clientAppError('TRANSCRIPTION_SOURCE_UNREADABLE');

      const checkpointKey = sttCheckpointKey(req.projectId, req.sourcePath, req.language);
      let checkpoint = loadSttCheckpoint(checkpointKey);
      const idempotencyKey = checkpointKey.replace('gensuite_stt_checkpoint_v1:', 'desktop-stt-');
      const submit = async () => {
        const form = new FormData();
        form.set('file', blob, 'source-16k.wav');
        form.set('durationSeconds', String(Math.max(1, Math.ceil(durationSeconds))));
        form.set('idempotencyKey', idempotencyKey);
        if (req.language && req.language !== 'auto') form.set('language', req.language);
        let data: any = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            data = await this.requestJson(`${BASE_URL}/stt`, {
              method: 'POST',
              headers: { 'Idempotency-Key': idempotencyKey },
              body: form,
            }, UPLOAD_TIMEOUT_MS);
            break;
          } catch (error) {
            const retryableSubmit = isPublicAppError(error)
              && ['TRANSCRIPTION_JOB_CONFLICT', 'TRANSCRIPTION_SERVICE_UNAVAILABLE', 'TRANSCRIPTION_REQUEST_TIMEOUT', 'TRANSCRIPTION_RATE_LIMITED'].includes(error.code);
            if (!retryableSubmit || attempt === 4) throw error;
            await delay(Math.min(8_000, 900 * 2 ** (attempt - 1)), this.controller?.signal);
          }
        }
        const jobId = String(data?.jobId ?? '');
        if (!jobId) throw clientAppError('TRANSCRIPTION_RESULT_INVALID');
        checkpoint = { jobId, createdAt: Date.now() };
        saveSttCheckpoint(checkpointKey, checkpoint);
        return jobId;
      };

      let jobId = checkpoint?.jobId || await submit();
      this.jobId = jobId;
      let job: any;
      try {
        job = await this.pollJob(jobId);
      } catch (error) {
        if (!isPublicAppError(error) || error.code !== 'TRANSCRIPTION_JOB_EXPIRED') throw error;
        localStorage.removeItem(checkpointKey);
        jobId = await submit();
        this.jobId = jobId;
        job = await this.pollJob(jobId);
      }
      const transcript = String(job?.transcript ?? '').trim();
      const words: SttWord[] = Array.isArray(job?.words) ? job.words : [];

      const segments = words.length
        ? groupWordsIntoSegments(words)
        : transcript
          ? estimateTranscriptSegments(transcript, durationSeconds)
          : [];
      if (!segments.length) throw clientAppError('TRANSCRIPTION_NO_SPEECH');
      localStorage.removeItem(checkpointKey);
      return segments;
    } finally {
      this.controller = null;
      this.jobId = '';
    }
  }

  private async loadSourceBlob(url: string): Promise<Blob> {
    const parentSignal = this.controller?.signal;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw clientAppError('TRANSCRIPTION_SOURCE_UNREADABLE');
      return await response.blob();
    } catch (error) {
      if (parentSignal?.aborted) throw clientAppError('TRANSCRIPTION_CANCELLED');
      if (timedOut) throw clientAppError('TRANSCRIPTION_AUDIO_PREPARATION_TIMEOUT');
      if (isPublicAppError(error)) throw error;
      throw clientAppError('TRANSCRIPTION_SOURCE_UNREADABLE');
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
    }
  }

  private async pollJob(jobId: string): Promise<any> {
    const hardDeadline = Date.now() + 60 * 60 * 1000;
    let inactivityDeadline = Date.now() + POLL_TIMEOUT_MS;
    let lastProgress = -1;
    let failures = 0;
    while (Date.now() < hardDeadline && Date.now() < inactivityDeadline) {
      try {
        const data = await this.requestJson(`${BASE_URL}/stt/${jobId}`, {}, REQUEST_TIMEOUT_MS);
        const status = String(data?.status ?? '').toLowerCase();
        const progress = Number(data?.progress ?? 0);
        if (Number.isFinite(progress) && progress > lastProgress) {
          lastProgress = progress;
          inactivityDeadline = Date.now() + POLL_TIMEOUT_MS;
        }
        if (status === 'done') return data;
        if (status === 'failed' || status === 'error') throw clientAppError('TRANSCRIPTION_CHUNK_FAILED');
        if (status === 'cancelled') throw clientAppError('TRANSCRIPTION_CANCELLED');
        failures = 0;
      } catch (error) {
        if (isPublicAppError(error)
          && ['TRANSCRIPTION_SERVICE_UNAVAILABLE', 'TRANSCRIPTION_REQUEST_TIMEOUT', 'TRANSCRIPTION_RATE_LIMITED'].includes(error.code)
          && failures < 4) {
          failures += 1;
          await delay(Math.min(8_000, 900 * 2 ** failures), this.controller?.signal);
          continue;
        }
        throw error;
      }
      await delay(POLL_INTERVAL_MS, this.controller?.signal);
    }
    throw clientAppError('TRANSCRIPTION_REQUEST_TIMEOUT');
  }

  cancel(): void {
    this.controller?.abort();
    const jobId = this.jobId;
    this.controller = null;
    this.jobId = '';
    if (jobId) gensuiteFetch(`${BASE_URL}/stt/${encodeURIComponent(jobId)}`, { method: 'DELETE' }, this.feature).catch(() => undefined);
  }
}

function sttFailure(status: number, code: string): unknown {
  if (status === 401 || code === 'INVALID_API_KEY' || code === 'AUTH_REQUIRED') return new Error('AUTH_REQUIRED:gensuite');
  if (code === 'FEATURE_UPGRADE_REQUIRED') return new Error('UPGRADE_REQUIRED:basic');
  if (status === 402 || code === 'INSUFFICIENT_CREDITS') return new Error('INSUFFICIENT_CREDITS');
  if (status === 429) return clientAppError('TRANSCRIPTION_RATE_LIMITED');
  if (status === 409) return clientAppError('TRANSCRIPTION_JOB_CONFLICT');
  if (status === 403) return clientAppError('TRANSCRIPTION_ACCESS_DENIED');
  if (status === 408) return clientAppError('TRANSCRIPTION_REQUEST_TIMEOUT');
  if (status === 404 || code === 'NOT_FOUND') return clientAppError('TRANSCRIPTION_JOB_EXPIRED');
  return clientAppError(status >= 500 ? 'TRANSCRIPTION_SERVICE_UNAVAILABLE' : 'TRANSCRIPTION_RESULT_INVALID');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(clientAppError('TRANSCRIPTION_CANCELLED')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function sttCheckpointKey(projectId: string, sourcePath: string, language?: string): string {
  let hash = 2166136261;
  for (const char of `${sourcePath}|${language || 'auto'}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `gensuite_stt_checkpoint_v1:${projectId}:${(hash >>> 0).toString(36)}`;
}

function loadSttCheckpoint(key: string): { jobId: string; createdAt: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as { jobId?: string; createdAt?: number } | null;
    if (!value?.jobId || !value.createdAt || Date.now() - value.createdAt > CHECKPOINT_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return { jobId: value.jobId, createdAt: value.createdAt };
  } catch { return null; }
}

function saveSttCheckpoint(key: string, value: { jobId: string; createdAt: number }): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* retry can submit a fresh job */ }
}

// Read a WAV Blob's duration through an <audio> element (renderer has no ffprobe).
function probeBlobDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const el = new Audio();
    const done = (value: number) => { URL.revokeObjectURL(objectUrl); resolve(value); };
    el.addEventListener('loadedmetadata', () => done(Number.isFinite(el.duration) ? el.duration : 0));
    el.addEventListener('error', () => done(0));
    el.src = objectUrl;
  });
}

function estimateTranscriptSegments(transcript: string, durationSeconds: number): TranscriptSegment[] {
  const phrases = transcript
    .replace(/\r\n|\r|\n/g, ' ')
    .split(/(?<=[.!?。！？…])\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const phrase of phrases.length ? phrases : [transcript.trim()]) {
    let remaining = phrase;
    while (remaining.length > MAX_SEGMENT_CHARS) {
      const window = remaining.slice(0, MAX_SEGMENT_CHARS + 1);
      let split = Math.max(window.lastIndexOf(', '), window.lastIndexOf('，'), window.lastIndexOf(' '));
      if (split < Math.floor(MAX_SEGMENT_CHARS * 0.45)) split = MAX_SEGMENT_CHARS;
      const part = remaining.slice(0, split + (split < MAX_SEGMENT_CHARS ? 1 : 0)).trim();
      if (part) parts.push(part);
      remaining = remaining.slice(split + (split < MAX_SEGMENT_CHARS ? 1 : 0)).trim();
    }
    if (remaining) parts.push(remaining);
  }
  const weights = parts.map((part) => Math.max(1, [...part].length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return parts.map((text, index) => {
    const start = durationSeconds * (cursor / total);
    cursor += weights[index];
    const end = index === parts.length - 1 ? durationSeconds : durationSeconds * (cursor / total);
    return { id: `seg_${index}`, start, end: Math.max(start + 0.01, end), text };
  });
}

// Group word timestamps into subtitle-sized segments: break on sentence-ending
// punctuation, a silent gap, or a max character budget. Keeps start/end aligned
// to the source audio so the re-dub can anchor each line to its original window.
function groupWordsIntoSegments(words: SttWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let index = 0;
  let buffer: string[] = [];
  let segStart = 0;
  let prevEnd = 0;

  const wordStart = (w: SttWord) => Number(w.start ?? w.startTime ?? 0);
  const wordEnd = (w: SttWord) => Number(w.end ?? w.endTime ?? 0);
  const wordText = (w: SttWord) => String(w.word ?? w.text ?? '').trim();

  const flush = (end: number) => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      segments.push({ id: `seg_${index++}`, start: segStart, end: Math.max(end, segStart), text });
    }
    buffer = [];
  };

  words.forEach((w) => {
    const text = wordText(w);
    if (!text) return;
    const start = wordStart(w);
    const end = wordEnd(w);
    if (!buffer.length) {
      segStart = start;
    } else if (start - prevEnd >= MAX_SEGMENT_GAP_SEC) {
      flush(prevEnd);
      segStart = start;
    }
    buffer.push(text);
    prevEnd = end;
    const joined = buffer.join(' ');
    if (SENTENCE_END.test(text) || joined.length >= MAX_SEGMENT_CHARS) {
      flush(end);
    }
  });
  flush(prevEnd);
  return segments;
}
