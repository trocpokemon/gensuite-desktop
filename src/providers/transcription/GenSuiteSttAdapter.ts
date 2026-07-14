import type { ITranscriptionProvider, TranscribeRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { localFileUrl } from '../../shared/localFile';

// GenSuite paid speech-to-text. Audio is extracted to a 16kHz mono WAV in the
// main process (shared with the local engine — this matches /v1/stt's required
// WAV LINEAR16 16kHz mono format). The renderer fetches that WAV as a Blob, POSTs
// it as multipart, then polls the async job until it finishes. The API returns a
// flat transcript plus word-level timestamps, which we group into timed segments.
const BASE_URL = 'https://api.gensuite.site/v1';
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

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

  constructor(private apiKey: string) {}

  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment[]> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:gensuite');

    const wavPath = await window.gensuite.whisper.extract({
      projectId: req.projectId,
      sourcePath: req.sourcePath,
    });

    const url = localFileUrl(wavPath);
    if (!url) throw new Error('Không đọc được file WAV đã trích.');
    const wavResp = await fetch(url);
    if (!wavResp.ok) throw new Error('Không đọc được file WAV đã trích.');
    const blob = await wavResp.blob();
    const durationSeconds = await probeBlobDuration(blob);

    const form = new FormData();
    form.set('file', blob, 'source-16k.wav');
    form.set('durationSeconds', String(Math.max(1, Math.ceil(durationSeconds))));
    if (req.language && req.language !== 'auto') form.set('language', req.language);

    const submit = await fetch(`${BASE_URL}/stt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey.trim()}` },
      body: form,
    });
    if (!submit.ok) throw await sttError(submit);
    const submitData = await submit.json().catch(() => null as any);
    const jobId = String(submitData?.jobId ?? '');
    if (!jobId) throw new Error('GenSuite STT không trả về jobId.');

    const job = await this.pollJob(jobId);
    const transcript = String(job?.transcript ?? '').trim();
    const words: SttWord[] = Array.isArray(job?.words) ? job.words : [];

    const segments = words.length
      ? groupWordsIntoSegments(words)
      : transcript
        ? [{ id: 'seg_0', start: 0, end: Math.max(1, durationSeconds), text: transcript }]
        : [];
    if (!segments.length) throw new Error('GenSuite STT không nhận dạng được lời thoại nào.');
    return segments;
  }

  private async pollJob(jobId: string): Promise<any> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const resp = await fetch(`${BASE_URL}/stt/${jobId}`, {
        headers: { Authorization: `Bearer ${this.apiKey.trim()}` },
      });
      if (!resp.ok) throw await sttError(resp);
      const data = await resp.json().catch(() => null as any);
      const status = String(data?.status ?? '');
      if (status === 'done') return data;
      if (status === 'failed' || status === 'error') {
        throw new Error(String(data?.error ?? 'GenSuite STT xử lý thất bại.').slice(0, 300));
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error('GenSuite STT quá thời gian chờ.');
  }
}

async function sttError(resp: Response): Promise<Error> {
  const data = await resp.json().catch(() => null as any);
  const code = String(data?.error ?? '');
  const message = String(data?.message ?? '');
  if (resp.status === 401 || resp.status === 403 || code === 'INVALID_API_KEY') return new Error('MISSING_KEY:gensuite');
  if (resp.status === 402 || code === 'INSUFFICIENT_CREDITS') return new Error('Tài khoản GenSuite không đủ credits để nhận dạng.');
  return new Error(`GenSuite STT lỗi ${resp.status}: ${message || code || 'yêu cầu thất bại'}`.slice(0, 300));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
