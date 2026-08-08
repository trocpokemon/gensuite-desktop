import type { PublicAppError } from './appErrors';
import type { Scene, SubtitleWordTiming, WhisperModelName } from './types';
import { clientAppError, normalizedClientAppError } from '../providers/clientAppError';

// Caption alignment operates on clean, generated speech whose exact script is
// already known. Reusing the much heavier source-transcription model here makes
// projects with many scenes needlessly slow without improving word boundaries.
const CAPTION_ALIGNMENT_MODEL: WhisperModelName = 'base';

export function hasFreshSubtitleTiming(scene: Scene): boolean {
  return Boolean(
    scene.audioPath &&
    scene.subtitleWords?.length &&
    scene.subtitleTimingText === scene.narration &&
    scene.subtitleTimingAudioPath === scene.audioPath,
  );
}

export interface SubtitleAlignmentOutcome {
  words: SubtitleWordTiming[];
  quality: 'exact' | 'aligned' | 'estimated';
  warning?: PublicAppError;
}

function timingWords(text: string): string[] {
  const clean = text.replace(/\r\n|\r|\n/g, ' ').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (/\s/.test(clean)) return clean.split(/\s+/).filter(Boolean);
  const cjk = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
  if (!cjk.test(clean)) return [clean];
  const words: string[] = [];
  for (const char of [...clean]) {
    if (/^[，。！？、；：,.!?;:）)】」』…]+$/.test(char) && words.length) words[words.length - 1] += char;
    else words.push(char);
  }
  return words;
}

function wordWeight(word: string): number {
  const length = [...word.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')].length;
  const pause = /[.!?。！？…]$/.test(word) ? 1.8 : /[,;:，、；：]$/.test(word) ? 0.8 : 0;
  return Math.max(1, length) + pause;
}

/** Safe last-resort timing. It preserves the exact script and always covers the audio. */
export function estimateSubtitleTiming(text: string, durationSec: number): SubtitleWordTiming[] {
  const words = timingWords(text);
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Math.max(0.8, words.length * 0.32);
  if (!words.length) return [];
  const weights = words.map(wordWeight);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return words.map((word, index) => {
    const start = duration * (cursor / total);
    cursor += weights[index];
    const end = index === words.length - 1 ? duration : duration * (cursor / total);
    return { word, start, end: Math.max(start + 0.01, end) };
  });
}

export async function alignSceneSubtitle(
  scene: Scene,
  projectId: string,
  language?: string,
  segmentNumber?: number,
  segmentCount?: number,
): Promise<SubtitleAlignmentOutcome> {
  if (hasFreshSubtitleTiming(scene)) {
    return { words: scene.subtitleWords ?? [], quality: scene.subtitleTimingQuality ?? 'exact' };
  }
  if (!scene.audioPath || !scene.narration.trim()) {
    return { words: estimateSubtitleTiming(scene.narration, scene.audioDuration ?? 0), quality: 'estimated' };
  }
  let result;
  try {
    result = await window.gensuite.whisper.align({
      projectId,
      audioPath: scene.audioPath,
      text: scene.narration,
      model: CAPTION_ALIGNMENT_MODEL,
      language,
      segmentNumber,
      segmentCount,
    });
  } catch (error) {
    return {
      words: estimateSubtitleTiming(scene.narration, scene.audioDuration ?? 0),
      quality: 'estimated',
      warning: normalizedClientAppError(error, 'SUBTITLE_ALIGNMENT_UNEXPECTED', segmentNumber && segmentCount ? { segmentNumber, segmentCount } : undefined),
    };
  }
  if (result.ok && result.value.length) return { words: result.value, quality: 'aligned' };
  return {
    words: estimateSubtitleTiming(scene.narration, scene.audioDuration ?? 0),
    quality: 'estimated',
    warning: result.ok
      ? clientAppError('SUBTITLE_ALIGNMENT_RESULT_INVALID', segmentNumber && segmentCount ? { segmentNumber, segmentCount } : undefined)
      : result.error,
  };
}
