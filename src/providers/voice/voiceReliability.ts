import type { SubtitleWordTiming } from '../../shared/types';
import type { VoiceRequest } from './types';

const CHECKPOINT_PREFIX = 'gensuite_voice_checkpoint_v1';
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export interface VoicePartCheckpoint {
  index: number;
  jobId?: string;
  audioPath?: string;
  durationSec?: number;
  wordTimings?: SubtitleWordTiming[];
  status: 'pending' | 'processing' | 'done';
}

export interface VoiceCheckpoint {
  schemaVersion: 1;
  requestKey: string;
  createdAt: number;
  parts: VoicePartCheckpoint[];
}

export function splitVoiceText(input: string, limit = 900): string[] {
  const text = input.replace(/\r\n|\r/g, '\n').trim();
  if (!text) return [];
  if (limit < 40) throw new Error('voice chunk limit is too small');
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [
      Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n')),
      Math.max(...['. ', '! ', '? ', '。', '！', '？', '…'].map((token) => window.lastIndexOf(token))),
      Math.max(...[', ', '; ', ': ', '，', '、', '；', '：'].map((token) => window.lastIndexOf(token))),
      window.lastIndexOf(' '),
    ];
    let splitAt = candidates.find((value) => value >= Math.floor(limit * 0.45)) ?? -1;
    if (splitAt < 1) splitAt = limit;
    else splitAt += 1;
    const part = remaining.slice(0, splitAt).trim();
    if (part) result.push(part);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(36)}${second.toString(36)}`;
}

export function voiceRequestKey(req: VoiceRequest, engine: string): string {
  return stableHash(JSON.stringify({
    engine,
    text: req.text,
    voiceId: req.voiceId,
    modelId: req.modelId,
    language: req.language,
    speed: req.speed,
    temperature: req.temperature,
    stability: req.stability,
    similarityBoost: req.similarityBoost,
    style: req.style,
    useSpeakerBoost: req.useSpeakerBoost,
    pitch: req.pitch,
    volume: req.volume,
    deliveryMode: req.deliveryMode,
  }));
}

function storageKey(projectId: string, segmentId: string, requestKey: string): string {
  return `${CHECKPOINT_PREFIX}:${projectId}:${segmentId}:${requestKey}`;
}

export async function loadVoiceCheckpoint(projectId: string, segmentId: string, requestKey: string): Promise<VoiceCheckpoint | null> {
  const key = storageKey(projectId, segmentId, requestKey);
  const result = await window.gensuite.localize.readCheckpoint({ projectId, scope: 'voice', key });
  if (!result.ok) throw result.error;
  const value = result.value as VoiceCheckpoint | null;
  if (!value || value.schemaVersion !== 1 || value.requestKey !== requestKey || !Array.isArray(value.parts)
    || Date.now() - value.createdAt > CHECKPOINT_TTL_MS) {
    const removed = await window.gensuite.localize.removeCheckpoint({ projectId, scope: 'voice', key });
    if (!removed.ok) throw removed.error;
    return null;
  }
  return value;
}

export async function saveVoiceCheckpoint(projectId: string, segmentId: string, checkpoint: VoiceCheckpoint): Promise<void> {
  const result = await window.gensuite.localize.writeCheckpoint({
    projectId,
    scope: 'voice',
    key: storageKey(projectId, segmentId, checkpoint.requestKey),
    value: checkpoint,
  });
  if (!result.ok) throw result.error;
}

export function createVoiceCheckpoint(requestKey: string, partCount: number): VoiceCheckpoint {
  return {
    schemaVersion: 1,
    requestKey,
    createdAt: Date.now(),
    parts: Array.from({ length: partCount }, (_, index) => ({ index, status: 'pending' })),
  };
}

export async function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = Math.min(8_000, 900 * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 250);
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
