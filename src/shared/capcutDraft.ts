import type { CapCutDraftExportArgs, SubtitleConfig } from './types';

export interface CapCutCompileItem {
  ref?: string;
  path?: string;
  text?: string;
  start: number;
  duration?: number;
  /** Playback multiplier used to fit generated speech into its source window. */
  speed?: number;
  volume?: number;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  type?: 'video' | 'photo';
}

export interface CapCutCompileTrack {
  type: 'video' | 'audio' | 'text';
  name: string;
  items: CapCutCompileItem[];
}

interface CapCutTextStyleOperation {
  op: 'text-style';
  target: string;
  style: {
    shadow?: boolean;
    shadowAlpha?: number;
    shadowColor?: string;
    shadowDistance?: number;
    shadowSmoothing?: number;
    borderWidth?: number;
    borderColor?: string;
    borderAlpha?: number;
    bgColor?: string;
    bgAlpha?: number;
    bgStyle?: number;
    bgRoundRadius?: number;
  };
}

export interface CapCutCompileSpec {
  name: string;
  width: number;
  height: number;
  fps: number;
  ratio: string;
  captionLanguage?: string;
  tracks: CapCutCompileTrack[];
  operations?: CapCutTextStyleOperation[];
}

export interface CapCutDraftBuildOptions {
  projectName?: string;
  width?: number;
  height?: number;
  fps?: number;
}

type DraftRecord = Record<string, unknown>;

const CAPTION_LANGUAGE_TAGS: Record<string, string> = {
  vietnamese: 'vi-VN', english: 'en-US', chinese: 'zh-Hans', japanese: 'ja-JP', korean: 'ko-KR',
  french: 'fr-FR', german: 'de-DE', spanish: 'es-ES', portuguese: 'pt-BR', italian: 'it-IT',
  russian: 'ru-RU', thai: 'th-TH', indonesian: 'id-ID', hindi: 'hi-IN', arabic: 'ar-SA',
};

function captionLanguageTag(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  return CAPTION_LANGUAGE_TAGS[normalized]
    ?? (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(normalized) ? normalized : 'und');
}

function draftRecord(value: unknown): DraftRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as DraftRecord : null;
}

/**
 * The draft compiler applies `segment.speed` but does not synchronize the
 * companion speed material or the media's real source duration. CapCut reads
 * all three values, so normalize them transactionally before registering the
 * project. The returned object is the same draft object, updated in place.
 */
export function synchronizeCapCutVoiceTiming(
  timeline: DraftRecord,
  spec: CapCutCompileSpec,
): DraftRecord {
  const voiceItems = spec.tracks.find((track) => track.type === 'audio' && track.name === 'Giọng thuyết minh')?.items ?? [];
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks.map(draftRecord).filter((item): item is DraftRecord => Boolean(item)) : [];
  const voiceTrack = tracks.find((track) => track.type === 'audio' && track.name === 'Giọng thuyết minh');
  const segments = Array.isArray(voiceTrack?.segments)
    ? voiceTrack.segments.map(draftRecord).filter((item): item is DraftRecord => Boolean(item))
    : [];
  if (!voiceItems.length || segments.length !== voiceItems.length) throw new TypeError('invalid voice track');

  segments.sort((left, right) => {
    const leftRange = draftRecord(left.target_timerange);
    const rightRange = draftRecord(right.target_timerange);
    return Number(leftRange?.start ?? 0) - Number(rightRange?.start ?? 0);
  });
  const materials = draftRecord(timeline.materials);
  const audioMaterials = Array.isArray(materials?.audios) ? materials.audios.map(draftRecord).filter((item): item is DraftRecord => Boolean(item)) : [];
  const speedMaterials = Array.isArray(materials?.speeds) ? materials.speeds.map(draftRecord).filter((item): item is DraftRecord => Boolean(item)) : [];

  let previousEndUs = 0;
  segments.forEach((segment, index) => {
    const item = voiceItems[index];
    const speed = item.speed ?? 1;
    if (!(item.duration && item.duration > 0) || !(speed > 0)) throw new TypeError('invalid voice timing');
    const startUs = Math.round(item.start * 1_000_000);
    const targetDurationUs = Math.round(item.duration * 1_000_000);
    const sourceDurationUs = Math.round(targetDurationUs * speed);
    if (startUs < previousEndUs) throw new TypeError('overlapping voice timing');
    previousEndUs = startUs + targetDurationUs;

    const targetRange = draftRecord(segment.target_timerange);
    const sourceRange = draftRecord(segment.source_timerange);
    if (!targetRange || !sourceRange) throw new TypeError('invalid voice segment');
    targetRange.start = startUs;
    targetRange.duration = targetDurationUs;
    sourceRange.start = 0;
    sourceRange.duration = sourceDurationUs;
    segment.speed = speed;

    const materialId = typeof segment.material_id === 'string' ? segment.material_id : '';
    const audioMaterial = audioMaterials.find((material) => material.id === materialId);
    if (!audioMaterial) throw new TypeError('missing voice material');
    audioMaterial.duration = sourceDurationUs;

    const extraRefs = Array.isArray(segment.extra_material_refs)
      ? new Set(segment.extra_material_refs.filter((value): value is string => typeof value === 'string'))
      : new Set<string>();
    const speedMaterial = speedMaterials.find((material) => typeof material.id === 'string' && extraRefs.has(material.id));
    if (!speedMaterial) throw new TypeError('missing speed material');
    speedMaterial.speed = speed;
  });
  return timeline;
}

/** Convert compiler-created text boxes to the same draft shape CapCut writes
 * for an automatic caption track, including recognition task and word timing
 * metadata required by CapCut's caption-only editing controls. */
export function synchronizeCapCutCaptionSemantics(
  timeline: DraftRecord,
  spec: CapCutCompileSpec,
): DraftRecord {
  const captionItems = spec.tracks.find((track) => track.type === 'text' && track.name === 'Phụ đề')?.items ?? [];
  if (!captionItems.length) return timeline;
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks.map(draftRecord).filter((item): item is DraftRecord => Boolean(item)) : [];
  const captionTrack = tracks.find((track) => track.type === 'text' && track.name === 'Phụ đề');
  const segments = Array.isArray(captionTrack?.segments)
    ? captionTrack.segments.map(draftRecord).filter((item): item is DraftRecord => Boolean(item))
    : [];
  if (segments.length !== captionItems.length) throw new TypeError('invalid caption track');
  const materials = draftRecord(timeline.materials);
  const textMaterials = Array.isArray(materials?.texts) ? materials.texts.map(draftRecord).filter((item): item is DraftRecord => Boolean(item)) : [];
  if (!materials) throw new TypeError('missing caption materials');
  const animationMaterials = Array.isArray(materials.material_animations)
    ? materials.material_animations.map(draftRecord).filter((item): item is DraftRecord => Boolean(item))
    : [];
  const captionLanguage = captionLanguageTag(spec.captionLanguage);
  const captionTrackId = String(captionTrack?.id ?? 'gensuite');
  const captionGroupId = `${captionLanguage}_${Date.now()}`;
  let taskSeed = 2166136261;
  let captionTaskToken = '';
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < captionTrackId.length; index += 1) {
      taskSeed = Math.imul(taskSeed ^ captionTrackId.charCodeAt(index), 16777619);
    }
    taskSeed = Math.imul(taskSeed ^ (round + 1), 16777619);
    captionTaskToken += (taskSeed >>> 0).toString(16).padStart(8, '0');
  }
  const captionTaskId = `${captionTaskToken}_8_0`;

  if (captionTrack) {
    captionTrack.name = '';
    captionTrack.flag = 1;
    captionTrack.attribute = 0;
    captionTrack.is_default_name = true;
  }

  const captionWordTiming = (text: string, durationSeconds: number): DraftRecord => {
    const tokens = text.match(/\s+|\S+/gu) ?? [];
    const spokenTokens = tokens.filter((token) => !/^\s+$/u.test(token));
    const totalWeight = spokenTokens.reduce((sum, token) => sum + Math.max(1, [...token].length), 0);
    const durationMs = Math.max(1, Math.round(durationSeconds * 1000));
    const startTime: number[] = [];
    const endTime: number[] = [];
    let elapsedMs = 0;
    let completedWeight = 0;
    let spokenIndex = 0;

    tokens.forEach((token) => {
      if (/^\s+$/u.test(token)) {
        startTime.push(elapsedMs);
        endTime.push(elapsedMs);
        return;
      }
      startTime.push(elapsedMs);
      completedWeight += Math.max(1, [...token].length);
      spokenIndex += 1;
      elapsedMs = spokenIndex === spokenTokens.length
        ? durationMs
        : Math.max(elapsedMs + 1, Math.round((durationMs * completedWeight) / Math.max(1, totalWeight)));
      endTime.push(elapsedMs);
    });

    return { start_time: startTime, end_time: endTime, text: tokens };
  };

  segments.forEach((segment, index) => {
    const materialId = typeof segment.material_id === 'string' ? segment.material_id : '';
    const material = textMaterials.find((item) => item.id === materialId);
    if (!material) throw new TypeError('missing caption material');
    material.type = 'subtitle';
    material.sub_type = 0;
    material.add_type = 1;
    material.initial_scale = 1;
    material.layer_weight = 1;
    material.language = captionLanguage;
    material.group_id = captionGroupId;
    material.recognize_task_id = captionTaskId;
    material.base_content = typeof material.content === 'string' ? material.content : '';
    material.recognize_text = captionItems[index]?.text ?? '';
    material.words = captionWordTiming(
      captionItems[index]?.text ?? '',
      captionItems[index]?.duration ?? 0,
    );
    material.current_words = { start_time: [], end_time: [], text: [] };
    material.subtitle_keywords = { range: [] };
    material.caption_template_info = {
      resource_id: '',
      third_resource_id: '',
      resource_name: '',
      category_id: '',
      category_name: '',
      effect_id: '',
      request_id: '',
      is_new: false,
      source_platform: 0,
    };
    segment.track_attribute = 0;
    segment.raw_segment_id = '';

    const animationId = `caption_animation_${String(segment.id ?? materialId)}`;
    const refs = Array.isArray(segment.extra_material_refs)
      ? segment.extra_material_refs.filter((value): value is string => typeof value === 'string')
      : [];
    if (!refs.includes(animationId)) refs.push(animationId);
    segment.extra_material_refs = refs;
    if (!animationMaterials.some((item) => item.id === animationId)) {
      animationMaterials.push({
        id: animationId,
        type: 'sticker_animation',
        animations: [],
        multi_language_current: 'none',
      });
    }
  });
  materials.material_animations = animationMaterials;

  const assistantInfo = draftRecord(timeline.function_assistant_info) ?? {};
  assistantInfo.auto_caption = false;
  assistantInfo.auto_caption_segid_list = [];
  if (typeof assistantInfo.auto_caption_template_id !== 'string') assistantInfo.auto_caption_template_id = '';
  timeline.function_assistant_info = assistantInfo;

  const config = draftRecord(timeline.config) ?? {};
  config.subtitle_recognition_id = '';
  config.subtitle_sync = true;
  config.subtitle_taskinfo = [{
    id: captionTaskId,
    type: 10,
    language: captionLanguage,
    content: '',
    remove_invalid_task_id: '',
    ai_accurate_recognize_enable: false,
    supplies_commit_id: '',
    is_local_asr: false,
  }];
  timeline.config = config;
  return timeline;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function safeColor(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

export function safeCapCutProjectName(input: string): string {
  const normalized = input
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = normalized || 'Dự án GenSuite';
  return `GenSuite - ${base}`.slice(0, 72).replace(/[. ]+$/g, '');
}

function subtitleCoordinates(style: SubtitleConfig): { x: number; y: number } {
  return {
    x: clamp((style.xPct - 50) / 50, -1, 1),
    // CapCut's vertical transform is positive upward; GenSuite stores Y from the top.
    y: clamp((50 - style.yPct) / 50, -1, 1),
  };
}

function subtitleStyle(style: SubtitleConfig): CapCutTextStyleOperation['style'] {
  const result: CapCutTextStyleOperation['style'] = {
    shadow: style.shadowDepth > 0,
    shadowAlpha: clamp(style.shadowDepth / 8, 0, 1),
    shadowColor: '#000000',
    shadowDistance: clamp(style.shadowDepth / 100, 0, 0.2),
    shadowSmoothing: clamp(style.shadowDepth / 10, 0, 1),
    borderWidth: clamp(style.outlineWidth, 0, 12),
    borderColor: safeColor(style.outlineColor, '#000000'),
    borderAlpha: style.outlineWidth > 0 ? 1 : 0,
  };
  if (style.backgroundStyle !== 'none') {
    result.bgColor = safeColor(style.backgroundColor, '#000000');
    result.bgAlpha = clamp(style.backgroundOpacity / 100, 0, 1);
    result.bgStyle = style.backgroundStyle === 'bar' ? 2 : 1;
    result.bgRoundRadius = clamp(style.backgroundRadius / 100, 0, 1);
  }
  return result;
}

/**
 * Convert a GenSuite narration timeline to the declarative, editor-neutral
 * shape consumed by the local draft writer. No filesystem details are read
 * here, which keeps timing and styling mapping independently testable.
 */
export function buildCapCutDraftSpec(
  args: CapCutDraftExportArgs,
  options: CapCutDraftBuildOptions = {},
): CapCutCompileSpec {
  const sourceDurationSec = args.sourceDurationSec;
  if (!args.sourceVideoPath || typeof sourceDurationSec !== 'number' || !finitePositive(sourceDurationSec)) {
    throw new TypeError('invalid source');
  }
  if (!Array.isArray(args.segments) || args.segments.length === 0) {
    throw new TypeError('missing segments');
  }

  const ordered = [...args.segments].sort((left, right) => left.sourceStart - right.sourceStart);
  ordered.forEach((segment) => {
    if (!segment.audioPath
      || !finitePositive(segment.audioDuration)
      || !Number.isFinite(segment.sourceStart)
      || segment.sourceStart < 0
      || !Number.isFinite(segment.sourceEnd)
      || segment.sourceEnd <= segment.sourceStart
      || segment.sourceEnd > sourceDurationSec + 0.25) {
      throw new TypeError('invalid segment');
    }
  });

  const width = Math.max(16, Math.round(options.width ?? 1920));
  const height = Math.max(16, Math.round(options.height ?? 1080));
  const projectName = options.projectName ?? safeCapCutProjectName(args.projectName);
  const tracks: CapCutCompileTrack[] = [
    {
      type: 'video',
      name: 'Video gốc',
      items: [{
        ref: 'source-video',
        path: args.sourceVideoPath,
        start: 0,
        duration: sourceDurationSec,
        volume: clamp(args.originalAudioVolume / 100, 0, 1),
        width,
        height,
      }],
    },
    {
      type: 'audio',
      name: 'Giọng thuyết minh',
      items: ordered.map((segment, index) => {
        const nextStart = ordered[index + 1]?.sourceStart ?? sourceDurationSec;
        const windowEnd = Math.min(sourceDurationSec, segment.sourceEnd, nextStart);
        const availableDuration = windowEnd - segment.sourceStart;
        if (!(availableDuration > 0.01)) throw new TypeError('invalid segment window');

        // The MP4 renderer already applies this same policy: natural speech is
        // kept unchanged when it fits; longer speech is accelerated just enough
        // to end inside the original line window. Explicit target duration also
        // prevents the draft writer from using the full file length and moving
        // overlapping clips onto additional audio tracks.
        const speed = segment.audioDuration > availableDuration
          ? segment.audioDuration / availableDuration
          : 1;
        const duration = Math.min(availableDuration, segment.audioDuration / speed);
        return {
          ref: `voice-${index + 1}`,
          path: segment.audioPath,
          start: segment.sourceStart,
          duration,
          speed,
          volume: 1,
        };
      }),
    },
  ];

  if (args.musicPath) {
    tracks.push({
      type: 'audio',
      name: 'Nhạc nền',
      items: [{
        ref: 'background-music',
        path: args.musicPath,
        start: 0,
        volume: clamp((args.musicVolume ?? 20) / 100, 0, 1),
      }],
    });
  }

  const operations: CapCutTextStyleOperation[] = [];
  if (args.subtitles) {
    const config = args.subtitleConfig;
    const coordinates = config ? subtitleCoordinates(config) : null;
    const style = config ? subtitleStyle(config) : null;
    tracks.push({
      type: 'text',
      name: 'Phụ đề',
      items: ordered.map((segment, index) => {
        const ref = `subtitle-${index + 1}`;
        if (style) operations.push({ op: 'text-style', target: ref, style });
        return {
          ref,
          text: segment.text.trim() || '…',
          start: segment.sourceStart,
          duration: Math.max(0.1, segment.sourceEnd - segment.sourceStart),
          ...(config && coordinates ? {
            fontSize: clamp(Math.round(config.fontSizePct * 3.6), 10, 72),
            color: safeColor(config.textColor, '#FFFFFF'),
            x: coordinates.x,
            y: coordinates.y,
          } : {}),
        };
      }),
    });
  }

  return {
    name: projectName,
    width,
    height,
    fps: clamp(Math.round(options.fps ?? 30), 1, 120),
    ratio: 'original',
    captionLanguage: args.captionLanguage,
    tracks,
    operations: operations.length ? operations : undefined,
  };
}
