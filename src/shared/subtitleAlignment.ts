import type { Scene, SubtitleWordTiming, WhisperModelName } from './types';

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

export async function alignSceneSubtitle(
  scene: Scene,
  projectId: string,
  language?: string,
): Promise<SubtitleWordTiming[]> {
  if (hasFreshSubtitleTiming(scene)) return scene.subtitleWords ?? [];
  if (!scene.audioPath || !scene.narration.trim()) return [];
  return window.gensuite.whisper.align({
    projectId,
    audioPath: scene.audioPath,
    text: scene.narration,
    model: CAPTION_ALIGNMENT_MODEL,
    language,
  });
}
