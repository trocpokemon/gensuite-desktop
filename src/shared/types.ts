// Shared domain types used by both the Electron main process and the React renderer.
// This file is the single source of truth for the IPC contract: every field here
// matches an actual handler signature in electron/ipc/*.

import type { IpcResult } from './appErrors';

export type AspectRatio = '16:9' | '9:16';
export type LocalizeAspectRatio = 'original' | AspectRatio;

export type ScriptEngine = 'gemini' | 'gensuite';
export type MediaEngine = 'pexels' | 'pixabay' | 'unsplash';
export type VoiceEngine = 'edgetts' | 'capcuttts' | 'genvoice' | 'elevenlabs' | 'minimax';
export type TranscriptionEngine = 'local' | 'cloud';

export type StepId = 'topic' | 'content' | 'storyboard' | 'voice' | 'timeline' | 'localize' | 'narrate';

export type ProjectStatus = 'draft' | 'content-approved' | 'storyboard-ready' | 'ready-to-export';
export type TopicSource = 'system' | 'user';
export type VisualType = 'stock-image' | 'stock-video' | 'ai-image' | 'ai-video' | 'upload';

/** Kind of project: topic production, imported-video localization, or visual narration. */
export type ProjectKind = 'topic' | 'localize' | 'narrate';
export type NarrationLanguage = 'vi-VN' | 'en-US' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'th-TH' | 'id-ID';
export type NarrationAudience = 'VN' | 'US' | 'CN' | 'JP' | 'KR' | 'TH' | 'ID';

/** Durable stages for the silent-video narration workflow. */
export type NarrationWorkflowStage =
  | 'idle'
  | 'source-ready'
  | 'ingesting'
  | 'segmenting'
  | 'analyzing'
  | 'planning'
  | 'synthesizing'
  | 'fitting'
  | 'review-ready'
  | 'voice-ready'
  | 'preview-ready'
  | 'rendering'
  | 'quality-checking'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** Exact local boundary. Semantic analysis may annotate it but never replace its timing. */
export interface ShotBoundary {
  id: string;
  startMs: number;
  endMs: number;
}

export interface ShotManifest {
  schemaVersion: 1;
  sourceFingerprint: string;
  durationMs: number;
  shots: ShotBoundary[];
}

/** A meaningful story beat composed from one or more technical shots. */
export interface SemanticBeat {
  id: string;
  shotIds: string[];
  startMs: number;
  endMs: number;
  description: string;
  importance: number;
  confidence: number;
}

export type NarrationFitStatus = 'pending' | 'fits' | 'needs-rewrite' | 'needs-review';
export type NarrationDensity = 'sparse' | 'balanced' | 'dense';

/** One editable narration cue placed inside an allowed visual window. */
export interface NarrationCue {
  id: string;
  beatIds: string[];
  windowStartMs: number;
  windowEndMs: number;
  preferredStartMs: number;
  text: string;
  maxDurationMs: number;
  priority: number;
  revision: number;
  fitStatus: NarrationFitStatus;
  audioPath?: string;
  audioDurationMs?: number;
  wordTimings?: SubtitleWordTiming[];
}

/** Small reference stored in project.json; larger manifests live beside project assets. */
export interface NarrationWorkflowState {
  schemaVersion: 1;
  stage: NarrationWorkflowStage;
  runId?: string;
  sourceFingerprint?: string;
  shotManifestPath?: string;
  semanticManifestPath?: string;
  narrationPlanPath?: string;
  qualityReportPath?: string;
  previewPath?: string;
  /** Probed source length used to detect missing narration at the end after resume. */
  sourceDurationMs?: number;
  /** Short user-facing synopsis kept with the project for fast resume. */
  summary?: string;
  shotCount?: number;
  targetLanguage?: NarrationLanguage;
  targetAudience?: NarrationAudience;
  density?: NarrationDensity;
  updatedAt?: string;
}

export type NarrationProgressPhase = 'preparing' | 'detecting-scenes' | 'understanding' | 'writing' | 'complete';

export interface NarrationAnalyzeArgs {
  projectId: string;
  sourceVideoPath: string;
  targetLanguage: NarrationLanguage;
  targetAudience: NarrationAudience;
  density: NarrationDensity;
}

export interface NarrationProgress {
  projectId: string;
  phase: NarrationProgressPhase;
  percent: number;
}

export interface NarrationAnalyzeResult {
  durationMs: number;
  sourceFingerprint: string;
  summary: string;
  shots: ShotBoundary[];
  beats: SemanticBeat[];
  cues: NarrationCue[];
  shotManifestPath: string;
  semanticManifestPath: string;
  narrationPlanPath: string;
}

export interface NarrationRewriteArgs {
  text: string;
  context: string;
  targetDurationMs: number;
  actualDurationMs: number;
  targetLanguage: NarrationLanguage;
  targetAudience: NarrationAudience;
  mode?: 'shorten' | 'expand';
}

export interface NarrationRewriteResult {
  text: string;
}

/** GGML model sizes for local whisper.cpp. Larger = more accurate, slower, bigger download. */
export type WhisperModelName = 'tiny' | 'base' | 'small' | 'medium';

/** One timed segment of recognized speech, produced by either whisper engine. */
export interface TranscriptSegment {
  id: string;
  /** Start time in seconds within the source media. */
  start: number;
  /** End time in seconds within the source media. */
  end: number;
  text: string;
}

export interface TopicConfig {
  id: string;
  name: string;
  description: string;
  /** Built-in asset URL or compressed data URL selected by the user. */
  thumbnail?: string;
  masterPrompt: string;
  defaultTone: string;
  targetAudience: string;
  defaultWordCount: number;
  visualStyle: string;
  negativePrompt: string;
  source: TopicSource;
}

export interface ScriptVersion {
  id: string;
  content: string;
  createdAt: string;
  label: string;
}

export interface ScriptDocument {
  content: string;
  approvedContent: string;
  status: 'draft' | 'approved';
  versions: ScriptVersion[];
}

export interface Scene {
  id: string;
  /** Narration/voiceover text for this scene. */
  narration: string;
  /** Image-generation / search prompt produced in step 1. */
  imagePrompt: string;
  /** Search keyword (auto-extracted from imagePrompt, editable in step 2). */
  keyword: string;
  /** Character offsets into the approved continuous document. */
  textStart?: number;
  textEnd?: number;
  /** For localize projects: start/end (seconds) of the source speech this scene was derived from. */
  sourceStart?: number;
  sourceEnd?: number;
  visualType?: VisualType;
  videoPrompt?: string;
  negativePrompt?: string;
  /** Absolute path (inside the project dir) of the chosen image, if any. */
  imagePath?: string;
  /** Absolute path of the synthesized audio, if any. */
  audioPath?: string;
  /** Audio duration in seconds, measured in the renderer after synthesis. */
  audioDuration?: number;
  /** Word timing measured from the synthesized voice, relative to audio start. */
  subtitleWords?: SubtitleWordTiming[];
  /** Cache identity so timing is invalidated when text or audio changes. */
  subtitleTimingText?: string;
  subtitleTimingAudioPath?: string;
  /** Narration-only production metadata used by the duration fitting loop. */
  narrationFitStatus?: NarrationFitStatus;
  narrationRevision?: number;
}

export interface MediaResult {
  id: string;
  mediaType: 'image' | 'video';
  /** Thumbnail URL for the grid. */
  thumbUrl: string;
  /** Full-resolution URL to download when selected. */
  fullUrl: string;
  width: number;
  height: number;
  author?: string;
  source: MediaEngine;
}

export type SubtitlePosition = 'top' | 'middle' | 'bottom';
export type SubtitleBackgroundStyle = 'rounded' | 'bar' | 'none';
export type OriginalSubtitleCoverMode = 'overlay' | 'blur' | 'restore';

export interface OriginalSubtitleCoverConfig {
  enabled: boolean;
  mode: OriginalSubtitleCoverMode;
  /** Cover rectangle in percentages of the source frame. */
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  opacity: number;
  blurStrength: number;
  /** Percentage of the cover's shorter edge blended into the surrounding frame. */
  featherPct: number;
  color: string;
}

export interface OriginalSubtitleCoverLayer extends OriginalSubtitleCoverConfig {
  /** Stable identity used by the canvas and timeline. */
  id: string;
  name: string;
  /** Inclusive start and exclusive end in source-video seconds. */
  startSec: number;
  endSec?: number;
}

export interface SubtitleWordTiming {
  word: string;
  /** Seconds relative to the start of the synthesized audio. */
  start: number;
  /** Seconds relative to the start of the synthesized audio. */
  end: number;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSizePct: number;
  textColor: string;
  highlightColor: string;
  futureOpacity: number;
  backgroundStyle: SubtitleBackgroundStyle;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundRadius: number;
  outlineColor: string;
  outlineWidth: number;
  shadowDepth: number;
  highlightGlow: number;
  position: SubtitlePosition;
  marginPct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  wordsPerPage: number;
}

export interface SubtitleConfig extends SubtitleStyle {
  /** Whether to burn captions into the exported video. */
  enabled: boolean;
  /** Selected built-in or user-created preset. Empty means the style was edited. */
  presetId: string;
  /** Exact caption anchor used by the draggable review stage. */
  xPct: number;
  yPct: number;
  /** Width of the caption layout box as a percentage of the output frame. */
  widthPct: number;
  /** Project-specific treatment for subtitles already present in the source video. */
  originalSubtitleCover: OriginalSubtitleCoverConfig;
  /** Independent cover layers. The legacy single cover above remains for migration. */
  originalSubtitleCovers: OriginalSubtitleCoverLayer[];
}

export interface SubtitlePreset {
  id: string;
  name: string;
  builtIn?: boolean;
  style: SubtitleStyle;
}

export interface MusicConfig {
  /** Whether to mix a background music track into the exported video. */
  enabled: boolean;
  /** Absolute path (inside the project dir) of the imported music file, if any. */
  audioPath?: string;
  /** Original file name, shown in the UI. */
  fileName?: string;
  /** Music volume as a percentage of the original (0–100). */
  volume: number;
}

export interface MusicImportResult {
  /** Absolute path of the copied file inside the project dir. */
  audioPath: string;
  /** Original file name, shown in the UI. */
  fileName: string;
}

export interface ProjectSettings {
  scriptEngine: ScriptEngine;
  /** GenSuite LLM model id used when scriptEngine === 'gensuite' (e.g. 'anthropic/claude-fable-5'). Empty = adapter default. */
  scriptModel: string;
  mediaEngine: MediaEngine;
  voiceEngine: VoiceEngine;
  /** One-time migration marker for the preferred free voice source. */
  freeVoicePriorityVersion?: number;
  aspectRatio: AspectRatio;
  /** Frame used by localized-video review and export. */
  localizeAspectRatio: LocalizeAspectRatio;
  /** Language and market used when writing visual narration. */
  narrationLanguage: NarrationLanguage;
  narrationAudience: NarrationAudience;
  narrationDensity: NarrationDensity;
  /** Explicit choices required before a newly-created localize project can advance. */
  localizeSourceLanguageConfirmed?: boolean;
  localizeTargetLanguageConfirmed?: boolean;
  localizeAccuracyConfirmed?: boolean;
  localizeVoiceProviderConfirmed?: boolean;
  tone: string;
  voiceId: string;
  voiceConfigs: Record<VoiceEngine, VoiceConfig>;
  subtitle: SubtitleConfig;
  /** Source-video audio retained below the translated voice (0–100). */
  originalAudioVolume: number;
  /** Optional user-selected folder for localized video exports. */
  localizeOutputDirectory: string;
  music: MusicConfig;
  /** Transcription engine for localize projects (local whisper.cpp vs cloud GenSuite STT). */
  transcriptionEngine: TranscriptionEngine;
  /** GGML model used by the local whisper engine. */
  whisperModel: WhisperModelName;
}

/** A project-level character reference image, reused across AI image scenes to
 * keep a recurring character visually consistent. Sent to the GenSuite image
 * API as a reference image (max 4 per generation). */
export interface CharacterRef {
  id: string;
  name: string;
  /** Absolute path (inside the project dir) of the reference image. */
  imagePath: string;
}

export interface VoiceConfig {
  voiceId: string;
  modelId: string;
  language: string;
  speed: number;
  temperature: number;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  pitch: number;
  volume: number;
  deliveryMode: 'STABLE' | 'BALANCED' | 'CREATIVE';
}

export interface ProjectState {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  currentStep: StepId;
  status: ProjectStatus;
  /** Discriminates a topic-driven production from an imported-video localization. */
  kind: ProjectKind;
  idea: string;
  topic: TopicConfig | null;
  /** Per-project custom copies keyed by topic id. */
  topicCustomizations: Record<string, TopicConfig>;
  script: ScriptDocument;
  scenes: Scene[];
  /** Snapshot identity used to reject storyboard scenes derived from old content. */
  storyboardSourceContent?: string;
  storyboardTopicId?: string;
  /** Localize projects: absolute path (inside the project dir) of the imported/downloaded source video. */
  sourceVideoPath?: string;
  /** Localize projects: detected/declared source spoken language. */
  sourceLanguage?: string;
  /** Localize projects: target language segments are translated into. */
  targetLanguage?: string;
  /** Localize projects: raw timed transcription before translation. */
  transcript?: TranscriptSegment[];
  /** Recognition pipeline revision used to invalidate incomplete legacy results. */
  transcriptionVersion?: number;
  /** Localize projects: absolute path of the finished re-dubbed video. */
  dubbedVideoPath?: string;
  /** Silent-video narration workflow checkpoint and manifest references. */
  narrationWorkflow?: NarrationWorkflowState;
  /** Project-level character references reused across AI image scenes. */
  characterRefs: CharacterRef[];
  settings: ProjectSettings;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  currentStep: StepId;
  status: ProjectStatus;
  topicName: string;
  wordCount: number;
  sceneCount: number;
  sizeBytes?: number;
  thumbnailPath?: string;
  thumbnailType?: 'image' | 'video';
}

/** Persisted third-party keys and user preferences. */
export interface AppSettings {
  googleApiKey: string;
  pexelsApiKey: string;
  pixabayApiKey: string;
  unsplashApiKey: string;
  /** User-created caption presets shared by every project. */
  subtitlePresets: SubtitlePreset[];
  /** Preset applied to newly created projects. */
  defaultSubtitlePresetId: string;
}

export interface HardwareInfo {
  vramMB: number;
  gpuModel: string;
  lowSpec: boolean;
}

// ---- IPC argument shapes (match handlers exactly) ----

export interface MediaDownloadArgs {
  projectId: string;
  sceneId: string;
  url: string;
  ext?: string;
}

export interface AudioWriteArgs {
  projectId: string;
  segmentId: string;
  /** base64-encoded audio bytes (from a cloud voice adapter's Blob). */
  base64: string;
  ext: string; // 'mp3' | 'wav'
}

export interface AudioDownloadArgs {
  projectId: string;
  segmentId: string;
  url: string;
  format?: string;
}

export interface CharacterImportResult {
  /** Absolute path of the copied reference image inside the project dir. */
  imagePath: string;
}

export interface EdgeTtsSynthesizeArgs {
  projectId: string;
  jobId: string;
  segmentId: string;
  text: string;
  /** Edge voice ShortName, e.g. 'vi-VN-HoaiMyNeural'. */
  voiceId: string;
  /** Speaking rate multiplier (1 = natural); converted to a signed percentage. */
  speed?: number;
  /** Baseline pitch shift in Hz (0 = default). */
  pitch?: number;
  /** Volume 0–100 (100 = default). */
  volume?: number;
}

export interface EdgeTtsSynthesizeResult {
  audioPath: string;
  /** Exact word boundaries returned with the generated speech, in seconds. */
  wordTimings?: SubtitleWordTiming[];
}

export interface EdgeTtsVoice {
  /** ShortName passed to synthesis, e.g. 'vi-VN-HoaiMyNeural'. */
  shortName: string;
  /** Human-facing name from the service. */
  friendlyName: string;
  locale: string;
  gender: string;
}

export interface CapCutTtsSynthesizeArgs {
  projectId: string;
  jobId: string;
  segmentId: string;
  text: string;
  voiceId: string;
  resourceId: string;
  speed?: number;
}

export interface CapCutTtsSynthesizeResult {
  audioPath: string;
  durationSec: number;
}

export interface CapCutTtsPreviewArgs {
  jobId: string;
  text: string;
  voiceId: string;
  resourceId: string;
  speed?: number;
}

export interface CapCutTtsPreviewResult {
  audioBase64: string;
}

export interface ExportScene {
  id: string;
  imagePath: string;
  visualType?: VisualType;
  audioPath: string;
  durationSec: number;
  /** Narration text; burned in as a subtitle when export requests it. */
  narration?: string;
  wordTimings?: SubtitleWordTiming[];
}

export interface ExportArgs {
  projectId: string;
  scenes: ExportScene[];
  ratio: AspectRatio;
  fps?: number;
  /** Burn each scene's narration into the video as a hard subtitle. */
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
  /** Absolute path of a background music track to mix under the narration. */
  musicPath?: string;
  /** Music volume as a percentage of the original (0–100). Defaults to 18. */
  musicVolume?: number;
}

export interface FfmpegProgress {
  projectId: string;
  timeSec: number;
  totalSec?: number;
  /** Monotonic overall progress for multi-stage completion. */
  percent?: number;
  phase?: 'preparing' | 'mixing-audio' | 'encoding' | 'complete';
  groupNumber?: number;
  groupCount?: number;
}

/** One dubbed line: its synthesized audio plus the source-video time window it
 * belongs to. Used to re-time and place the translated speech over the original. */
export interface RedubSegment {
  /** Absolute path of the synthesized (translated) audio for this line. */
  audioPath: string;
  /** Start time (seconds) of the original speech this line replaces. */
  sourceStart: number;
  /** End time (seconds) of the original speech this line replaces. */
  sourceEnd: number;
  /** Translated text, burned as a subtitle when requested. */
  text: string;
  /** Word timing relative to this synthesized audio. */
  wordTimings?: SubtitleWordTiming[];
  /** Known synthesized duration. Avoids re-reading every audio file for large projects. */
  audioDuration?: number;
}

export interface RedubArgs {
  projectId: string;
  /** Absolute path of the original source video whose visuals are kept. */
  sourceVideoPath: string;
  /** Translated audio lines with their source-video time windows. */
  segments: RedubSegment[];
  /** Optional safety ceiling for speech speed adjustment. */
  maxTempoFactor?: number;
  /** Burn the translated text into the video as a hard subtitle. */
  subtitles?: boolean;
  subtitleConfig?: SubtitleConfig;
  /** Preserve the source frame or fit it inside a selected delivery frame. */
  outputAspectRatio?: LocalizeAspectRatio;
  /** Percentage of the source audio retained under the translated voice. Defaults to 8. */
  originalAudioVolume?: number;
  /** Optional background track mixed under the timed narration. */
  musicPath?: string;
  musicVolume?: number;
  /** Optional absolute folder selected before processing starts. */
  outputDirectory?: string;
  /** When provided, save directly inside the project's output folder instead of asking for a location. */
  automaticOutputName?: string;
  /** Reveal the finished file in the file manager. Defaults to true for interactive exports. */
  revealOutput?: boolean;
}

export interface WhisperAlignArgs {
  projectId: string;
  audioPath: string;
  text: string;
  model: WhisperModelName;
  language?: string;
}

export interface YtdlpDownloadArgs {
  projectId: string;
  url: string;
}

export interface YtdlpProgress {
  projectId: string;
  /** Download completion 0–100. */
  percent: number;
  phase?: 'preparing' | 'downloading' | 'merging' | 'complete';
}

export interface PickTextResult {
  name: string;
  content: string;
}

export interface SaveTextArgs {
  content: string;
  defaultName: string;
  /** File extensions without a leading dot. */
  extensions: string[];
}

export interface SaveCopyArgs {
  sourcePath: string;
  defaultName?: string;
}

/** Extract a 16kHz mono WAV from the source media for whisper. */
export interface WhisperExtractArgs {
  projectId: string;
  /** Absolute path of the source video/audio to extract from. */
  sourcePath: string;
}

export interface WhisperTranscribeArgs {
  projectId: string;
  /** Absolute path of the 16kHz mono WAV produced by whisper:extract. */
  wavPath: string;
  model: WhisperModelName;
  /** Optional source-language hint (e.g. 'en'); omitted = auto-detect. */
  language?: string;
}

export interface WhisperModelStatusArgs {
  model: WhisperModelName;
}

export interface WhisperModelStatus {
  model: WhisperModelName;
  /** Whether the GGML file is already present on disk. */
  present: boolean;
  /** Absolute path where the model is / will be stored. */
  path: string;
}

export interface WhisperModelDownloadArgs {
  model: WhisperModelName;
}

export interface WhisperProgress {
  /** Coarse phase so the renderer can label the bar. */
  phase: 'extracting' | 'downloading-model' | 'transcribing' | 'complete';
  /** 0–100 where measurable (data download or recognized audio); omitted for indeterminate work. */
  percent?: number;
  model?: WhisperModelName;
  chunkNumber?: number;
  chunkCount?: number;
}

/** Tokens parsed from the `gensuite://auth-callback` deep-link after OAuth. */
export interface AuthCallbackPayload {
  accessToken: string;
  refreshToken: string;
}

/** Auto-update lifecycle forwarded from electron-updater to the renderer. */
export type UpdaterStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; manualDownload?: boolean }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/** The type-safe API surface exposed to the renderer via contextBridge. */
export interface GensuiteBridge {
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
  shell: {
    /** Open a URL in the user's default external browser. */
    openExternal(url: string): void;
    /** Reveal a generated/downloaded file in the OS file manager. */
    showItemInFolder(filePath: string): void;
    /** Ask the user to choose a folder. */
    selectDirectory(defaultPath?: string): Promise<string | null>;
  };
  hardware: {
    scan(): Promise<HardwareInfo>;
  };
  project: {
    save(state: ProjectState): Promise<string>;
    load(id: string): Promise<ProjectState | null>;
    loadLast(): Promise<ProjectState | null>;
    list(): Promise<ProjectState[]>;
    remove(id: string): Promise<void>;
    dir(id: string): Promise<string>;
    size(id: string): Promise<number>;
    openDir(id: string): Promise<void>;
    cleanup(id: string): Promise<void>;
  };
  topics: {
    load(): Promise<TopicConfig[]>;
    save(topics: TopicConfig[]): Promise<void>;
  };
  settings: {
    load(): Promise<AppSettings>;
    save(settings: AppSettings): Promise<void>;
  };
  media: {
    download(args: MediaDownloadArgs): Promise<string>;
  };
  music: {
    /** Open a file picker and copy the chosen audio into the project dir. Returns null if cancelled. */
    import(projectId: string): Promise<MusicImportResult | null>;
  };
  characters: {
    /** Open a file picker and copy a character reference image into the project dir. Returns null if cancelled. */
    import(projectId: string): Promise<CharacterImportResult | null>;
  };
  audio: {
    write(args: AudioWriteArgs): Promise<string>;
    download(args: AudioDownloadArgs): Promise<string>;
  };
  edgetts: {
    voices(): Promise<EdgeTtsVoice[]>;
    synthesize(args: EdgeTtsSynthesizeArgs): Promise<EdgeTtsSynthesizeResult>;
    kill(jobId: string): Promise<boolean>;
  };
  capcuttts: {
    synthesize(args: CapCutTtsSynthesizeArgs): Promise<IpcResult<CapCutTtsSynthesizeResult>>;
    preview(args: CapCutTtsPreviewArgs): Promise<IpcResult<CapCutTtsPreviewResult>>;
    kill(jobId: string): Promise<boolean>;
  };
  ffmpeg: {
    export(args: ExportArgs): Promise<string | null>;
    /** Re-dub: keep the source video's visuals, replace its audio with the translated lines. Returns the output path or null if cancelled. */
    redub(args: RedubArgs): Promise<IpcResult<string | null>>;
    onProgress(cb: (p: FfmpegProgress) => void): () => void;
  };
  narration: {
    /** Analyze an imported video and produce an editable, time-bounded narration draft. */
    analyze(args: NarrationAnalyzeArgs): Promise<NarrationAnalyzeResult>;
    rewrite(args: NarrationRewriteArgs): Promise<NarrationRewriteResult>;
    onProgress(cb: (p: NarrationProgress) => void): () => void;
  };
  ytdlp: {
    /** Download a video by URL into <project>/source/. Returns the absolute file path. */
    download(args: YtdlpDownloadArgs): Promise<string>;
    /** Open an isolated Douyin sign-in window after explicit user consent. */
    loginDouyin(): Promise<boolean>;
    /** Remove the isolated Douyin session retained by the app. */
    clearDouyinSession(): Promise<void>;
    /** Open an isolated TikTok sign-in window after explicit user consent. */
    loginTikTok(): Promise<boolean>;
    /** Remove the isolated TikTok session retained by the app. */
    clearTikTokSession(): Promise<void>;
    /** Open a file picker and copy a local video/audio into <project>/source/. Returns null if cancelled. */
    import(projectId: string): Promise<string | null>;
    /** Pick and copy multiple local video/audio files into <project>/source/. */
    importMany(projectId: string): Promise<string[]>;
    onProgress(cb: (p: YtdlpProgress) => void): () => void;
  };
  files: {
    /** Pick a UTF-8 text or SRT file. */
    pickText(): Promise<PickTextResult | null>;
    /** Save generated UTF-8 text through the native save dialog. */
    saveText(args: SaveTextArgs): Promise<string | null>;
    /** Copy a generated media file to a location chosen by the user. */
    saveCopy(args: SaveCopyArgs): Promise<string | null>;
  };
  whisper: {
    /** Extract a 16kHz mono WAV for transcription. Returns the absolute WAV path. */
    extract(args: WhisperExtractArgs): Promise<IpcResult<string>>;
    /** Run local whisper.cpp on the WAV. Returns timed segments. */
    transcribe(args: WhisperTranscribeArgs): Promise<IpcResult<TranscriptSegment[]>>;
    /** Measure word timing from synthesized voice audio for caption highlighting. */
    align(args: WhisperAlignArgs): Promise<SubtitleWordTiming[]>;
    modelStatus(args: WhisperModelStatusArgs): Promise<WhisperModelStatus>;
    /** Download the GGML model on demand. Returns its absolute path. */
    downloadModel(args: WhisperModelDownloadArgs): Promise<string>;
    onProgress(cb: (p: WhisperProgress) => void): () => void;
  };
  auth: {
    /** Fires when the OAuth deep-link returns with tokens. Returns an unsubscribe fn. */
    onCallback(cb: (payload: AuthCallbackPayload) => void): () => void;
  };
  updater: {
    /** Return the latest cached lifecycle state so a late-mounted UI cannot miss it. */
    getStatus(): Promise<UpdaterStatus>;
    /** Subscribe to update lifecycle events. Returns an unsubscribe fn. */
    onStatus(cb: (status: UpdaterStatus) => void): () => void;
    check(): void;
    download(): void;
    install(): void;
  };
}

declare global {
  interface Window {
    gensuite: GensuiteBridge;
  }
}
