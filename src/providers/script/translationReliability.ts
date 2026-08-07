import type { TranscriptSegment } from '../../shared/types';
import { findConsecutiveRepetitionRuns, normalizeTranscriptText, type RepetitionRun } from '../../shared/transcriptQuality';
import { clientAppError } from '../clientAppError';
import { buildTranslatePrompt, parseTranslationJson } from './prompt';
import type { TranslateRequest } from './types';

export const MAX_TRANSLATION_BATCH_SEGMENTS = 32;
export const MAX_TRANSLATION_BATCH_CHARS = 4_800;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export interface TranslationBatch {
  startIndex: number;
  segments: TranscriptSegment[];
}

interface TranslationCheckpoint {
  schemaVersion: 1;
  fingerprint: string;
  createdAt: number;
  completed: Record<string, string[]>;
}

export function splitTranslationBatches(segments: TranscriptSegment[]): TranslationBatch[] {
  const batches: TranslationBatch[] = [];
  let startIndex = 0;
  let current: TranscriptSegment[] = [];
  let chars = 0;
  const flush = () => {
    if (!current.length) return;
    batches.push({ startIndex, segments: current });
    startIndex += current.length;
    current = [];
    chars = 0;
  };

  for (const segment of segments) {
    const nextChars = segment.text.trim().length + 16;
    if (current.length && (current.length >= MAX_TRANSLATION_BATCH_SEGMENTS || chars + nextChars > MAX_TRANSLATION_BATCH_CHARS)) flush();
    current.push(segment);
    chars += nextChars;
  }
  flush();
  return batches;
}

export function findTranslationCollapseRuns(
  source: TranscriptSegment[],
  translated: TranscriptSegment[],
): RepetitionRun[] {
  return findConsecutiveRepetitionRuns(translated).filter((run) => {
    const target = normalizeTranscriptText(translated[run.startIndex]?.text ?? '');
    if (target.length < 4) return false;
    const distinctSource = new Set(
      source.slice(run.startIndex, run.endIndex + 1)
        .map((segment) => normalizeTranscriptText(segment.text))
        .filter(Boolean),
    );
    return distinctSource.size >= Math.max(2, Math.ceil(run.length * 0.6));
  });
}

function stableHash(value: string): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function checkpointIdentity(req: TranslateRequest, provider: string): { key: string; fingerprint: string } | null {
  if (!req.projectId) return null;
  const fingerprint = stableHash(JSON.stringify({
    provider,
    sourceLanguage: req.sourceLanguage || 'auto',
    targetLanguage: req.targetLanguage,
    segments: req.segments.map((segment) => [segment.id, segment.start, segment.end, segment.text]),
  }));
  return {
    key: `gensuite_translation_checkpoint_v1:${req.projectId}:${provider}:${fingerprint}`,
    fingerprint,
  };
}

function loadCheckpoint(identity: { key: string; fingerprint: string } | null): TranslationCheckpoint | null {
  if (!identity) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(identity.key) || 'null') as TranslationCheckpoint | null;
    if (!parsed || parsed.schemaVersion !== 1 || parsed.fingerprint !== identity.fingerprint
      || Date.now() - parsed.createdAt > CHECKPOINT_TTL_MS || !parsed.completed) {
      localStorage.removeItem(identity.key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCheckpoint(identity: { key: string; fingerprint: string } | null, checkpoint: TranslationCheckpoint): void {
  if (!identity) return;
  try { localStorage.setItem(identity.key, JSON.stringify(checkpoint)); } catch { /* checkpoint is optional */ }
}

function removeCheckpoint(identity: { key: string; fingerprint: string } | null): void {
  if (!identity) return;
  try { localStorage.removeItem(identity.key); } catch { /* storage is optional */ }
}

async function translateCompleteBatch(
  req: TranslateRequest,
  segments: TranscriptSegment[],
  call: (prompt: string) => Promise<string>,
): Promise<TranscriptSegment[]> {
  let translated: TranscriptSegment[];
  try {
    translated = parseTranslationJson(await call(buildTranslatePrompt({ ...req, segments })), segments);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'TRANSLATION_RESULT_INCOMPLETE') throw error;
    if (segments.length <= 1) throw clientAppError('TRANSLATION_RESULT_INCOMPLETE');
    const midpoint = Math.ceil(segments.length / 2);
    return [
      ...await translateCompleteBatch(req, segments.slice(0, midpoint), call),
      ...await translateCompleteBatch(req, segments.slice(midpoint), call),
    ];
  }

  const collapsed = findTranslationCollapseRuns(segments, translated);
  if (!collapsed.length) return translated;

  const repaired = [...translated];
  for (const run of collapsed) {
    for (let index = run.startIndex; index <= run.endIndex; index += 1) {
      const one = segments[index];
      try {
        repaired[index] = parseTranslationJson(await call(buildTranslatePrompt({ ...req, segments: [one] })), [one])[0];
      } catch (error) {
        if (error instanceof Error && error.message === 'TRANSLATION_RESULT_INCOMPLETE') {
          throw clientAppError('TRANSLATION_RESULT_INCOMPLETE');
        }
        throw error;
      }
    }
  }
  if (findTranslationCollapseRuns(segments, repaired).length) throw clientAppError('TRANSLATION_REPETITION_DETECTED');
  return repaired;
}

export async function translateSegmentsReliably(
  req: TranslateRequest,
  provider: string,
  call: (prompt: string) => Promise<string>,
): Promise<TranscriptSegment[]> {
  if (!req.segments.length) return [];
  const batches = splitTranslationBatches(req.segments);
  const identity = checkpointIdentity(req, provider);
  const checkpoint = loadCheckpoint(identity) ?? {
    schemaVersion: 1,
    fingerprint: identity?.fingerprint ?? '',
    createdAt: Date.now(),
    completed: {},
  } satisfies TranslationCheckpoint;
  const translated: TranscriptSegment[] = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const cachedText = checkpoint.completed[String(index)];
    let result = Array.isArray(cachedText) && cachedText.length === batch.segments.length && cachedText.every((text) => text.trim())
      ? batch.segments.map((segment, itemIndex) => ({ ...segment, text: cachedText[itemIndex].trim() }))
      : null;
    if (result && findTranslationCollapseRuns(batch.segments, result).length) result = null;
    if (!result) {
      result = await translateCompleteBatch(req, batch.segments, call);
      checkpoint.completed[String(index)] = result.map((segment) => segment.text);
      saveCheckpoint(identity, checkpoint);
    }
    translated.push(...result);
  }

  const crossBatchCollapse = findTranslationCollapseRuns(req.segments, translated);
  if (crossBatchCollapse.length) {
    for (const run of crossBatchCollapse) {
      for (let index = run.startIndex; index <= run.endIndex; index += 1) {
        const one = req.segments[index];
        try {
          translated[index] = parseTranslationJson(await call(buildTranslatePrompt({ ...req, segments: [one] })), [one])[0];
        } catch (error) {
          if (error instanceof Error && error.message === 'TRANSLATION_RESULT_INCOMPLETE') {
            throw clientAppError('TRANSLATION_RESULT_INCOMPLETE');
          }
          throw error;
        }
      }
    }
  }
  if (findTranslationCollapseRuns(req.segments, translated).length) throw clientAppError('TRANSLATION_REPETITION_DETECTED');
  removeCheckpoint(identity);
  return translated;
}
