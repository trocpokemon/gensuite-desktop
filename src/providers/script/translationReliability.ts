import type { TranscriptSegment } from '../../shared/types';
import { findConsecutiveRepetitionRuns, normalizeTranscriptText, type RepetitionRun } from '../../shared/transcriptQuality';
import { clientAppError } from '../clientAppError';
import { buildTranslatePrompt, parseTranslationJson } from './prompt';
import type { TranslateRequest, TranslationProgress } from './types';

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

function checkpointIdentity(req: TranslateRequest, provider: string): { projectId: string; key: string; fingerprint: string } | null {
  if (!req.projectId) return null;
  const fingerprint = stableHash(JSON.stringify({
    provider,
    sourceLanguage: req.sourceLanguage || 'auto',
    targetLanguage: req.targetLanguage,
    segments: req.segments.map((segment) => [segment.id, segment.start, segment.end, segment.text]),
  }));
  return {
    projectId: req.projectId,
    key: `gensuite_translation_checkpoint_v1:${req.projectId}:${provider}:${fingerprint}`,
    fingerprint,
  };
}

async function loadCheckpoint(identity: { projectId: string; key: string; fingerprint: string } | null): Promise<TranslationCheckpoint | null> {
  if (!identity) return null;
  const result = await window.gensuite.localize.readCheckpoint({ projectId: identity.projectId, scope: 'translation', key: identity.key });
  if (!result.ok) throw result.error;
  const parsed = result.value as TranslationCheckpoint | null;
  if (!parsed || parsed.schemaVersion !== 1 || parsed.fingerprint !== identity.fingerprint
    || Date.now() - parsed.createdAt > CHECKPOINT_TTL_MS || !parsed.completed) {
    const removed = await window.gensuite.localize.removeCheckpoint({ projectId: identity.projectId, scope: 'translation', key: identity.key });
    if (!removed.ok) throw removed.error;
    return null;
  }
  return parsed;
}

async function saveCheckpoint(identity: { projectId: string; key: string; fingerprint: string } | null, checkpoint: TranslationCheckpoint): Promise<void> {
  if (!identity) return;
  const result = await window.gensuite.localize.writeCheckpoint({ projectId: identity.projectId, scope: 'translation', key: identity.key, value: checkpoint });
  if (!result.ok) throw result.error;
}

async function removeCheckpoint(identity: { projectId: string; key: string; fingerprint: string } | null): Promise<void> {
  if (!identity) return;
  const result = await window.gensuite.localize.removeCheckpoint({ projectId: identity.projectId, scope: 'translation', key: identity.key });
  if (!result.ok) throw result.error;
}

async function translateCompleteBatch(
  req: TranslateRequest,
  segments: TranscriptSegment[],
  call: (prompt: string) => Promise<string>,
  heartbeat: () => void,
): Promise<TranscriptSegment[]> {
  let raw: string;
  try {
    heartbeat();
    raw = await call(buildTranslatePrompt({ ...req, segments }));
  } catch (error) {
    throw error;
  }

  let translated: TranscriptSegment[];
  try {
    translated = parseTranslationJson(raw, segments);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'TRANSLATION_RESULT_INCOMPLETE') {
      throw clientAppError('TRANSLATION_RESULT_INVALID');
    }
    if (segments.length <= 1) throw clientAppError('TRANSLATION_RESULT_INCOMPLETE');
    const midpoint = Math.ceil(segments.length / 2);
    return [
      ...await translateCompleteBatch(req, segments.slice(0, midpoint), call, heartbeat),
      ...await translateCompleteBatch(req, segments.slice(midpoint), call, heartbeat),
    ];
  }

  const collapsed = findTranslationCollapseRuns(segments, translated);
  if (!collapsed.length) return translated;

  const repaired = [...translated];
  for (const run of collapsed) {
    for (let index = run.startIndex; index <= run.endIndex; index += 1) {
      const one = segments[index];
      try {
        heartbeat();
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
  const checkpoint = await loadCheckpoint(identity) ?? {
    schemaVersion: 1,
    fingerprint: identity?.fingerprint ?? '',
    createdAt: Date.now(),
    completed: {},
  } satisfies TranslationCheckpoint;
  const translated: TranscriptSegment[] = [];
  const report = (progress: Omit<TranslationProgress, 'totalSegments' | 'batchCount'>) => req.onProgress?.({
    ...progress,
    totalSegments: req.segments.length,
    batchCount: batches.length,
  });

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const cachedText = checkpoint.completed[String(index)];
    let result = Array.isArray(cachedText) && cachedText.length === batch.segments.length && cachedText.every((text) => text.trim())
      ? batch.segments.map((segment, itemIndex) => ({ ...segment, text: cachedText[itemIndex].trim() }))
      : null;
    if (result && findTranslationCollapseRuns(batch.segments, result).length) result = null;
    if (!result) {
      result = await translateCompleteBatch(req, batch.segments, call, () => report({
        completedSegments: translated.length,
        batchNumber: index + 1,
        phase: 'requesting',
      }));
      checkpoint.completed[String(index)] = result.map((segment) => segment.text);
      await saveCheckpoint(identity, checkpoint);
    }
    translated.push(...result);
    report({
      completedSegments: translated.length,
      batchNumber: index + 1,
      phase: index === batches.length - 1 ? 'validating' : 'completed',
    });
  }

  const crossBatchCollapse = findTranslationCollapseRuns(req.segments, translated);
  if (crossBatchCollapse.length) {
    for (const run of crossBatchCollapse) {
      for (let index = run.startIndex; index <= run.endIndex; index += 1) {
        const one = req.segments[index];
        try {
          report({ completedSegments: index, batchNumber: batches.length, phase: 'validating' });
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
  await removeCheckpoint(identity);
  report({ completedSegments: req.segments.length, batchNumber: batches.length, phase: 'completed' });
  return translated;
}
