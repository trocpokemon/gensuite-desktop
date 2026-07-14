// Shared domain types used by both the Electron main process and the React renderer.
// This file is the single source of truth for the IPC contract: every field here
// matches an actual handler signature in electron/ipc/*.

export type AspectRatio = '16:9' | '9:16';

export type ScriptEngine = 'gemini' | 'gensuite';
export type MediaEngine = 'pexels' | 'pixabay' | 'unsplash';
export type VoiceEngine = 'edgetts' | 'genvoice' | 'elevenlabs' | 'minimax';
export type TranscriptionEngine = 'local' | 'cloud';

export type StepId = 'topic' | 'content' | 'storyboard' | 'voice' | 'timeline' | 'localize';

export type ProjectStatus = 'draft' | 'content-approved' | 'storyboard-ready' | 'ready-to-export';
export type TopicSource = 'system' | 'user';
export type VisualType = 'stock-image' | 'stock-video' | 'ai-image' | 'ai-video' | 'upload';

/** Kind of project: a topic-driven production, or an imported-video localization. */
export type ProjectKind = 'topic' | 'localize';

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

export interface SubtitleConfig {
  /** Whether to burn captions into the exported video by default. */
  enabled: boolean;
  /** Font family name (must be installed on the system, e.g. 'Arial'). */
  fontFamily: string;
  /** Font size as a percentage of the video height (e.g. 5 = 5%). */
  fontSizePct: number;
  /** Fill colour as #RRGGBB. */
  primaryColor: string;
  /** Outline (stroke) colour as #RRGGBB. */
  outlineColor: string;
  /** Outline thickness in pixels at 1080p, scaled with resolution. */
  outlineWidth: number;
  /** Drop-shadow depth in pixels at 1080p, scaled with resolution. */
  shadow: number;
  bold: boolean;
  position: SubtitlePosition;
  /** Soft wrap width: max characters per line before a line break (0 = no wrap). */
  maxCharsPerLine: number;
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
  aspectRatio: AspectRatio;
  tone: string;
  voiceId: string;
  voiceConfigs: Record<VoiceEngine, VoiceConfig>;
  subtitle: SubtitleConfig;
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
  /** Localize projects: absolute path of the finished re-dubbed video. */
  dubbedVideoPath?: string;
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
}

/** Persisted API keys. Field names match electron/ipc/settings.ts DEFAULT_SETTINGS. */
export interface AppSettings {
  googleApiKey: string;
  pexelsApiKey: string;
  pixabayApiKey: string;
  unsplashApiKey: string;
  gensuiteApiKey: string;
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

export interface EdgeTtsVoice {
  /** ShortName passed to synthesis, e.g. 'vi-VN-HoaiMyNeural'. */
  shortName: string;
  /** Human-facing name from the service. */
  friendlyName: string;
  locale: string;
  gender: string;
}

export interface ExportScene {
  id: string;
  imagePath: string;
  visualType?: VisualType;
  audioPath: string;
  durationSec: number;
  /** Narration text; burned in as a subtitle when export requests it. */
  narration?: string;
}

export interface ExportArgs {
  projectId: string;
  scenes: ExportScene[];
  ratio: AspectRatio;
  fps?: number;
  /** Burn each scene's narration into the video as a hard subtitle. */
  subtitles?: boolean;
  /** Styling for the burned-in subtitles; falls back to defaults when omitted. */
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
  phase?: 'preparing' | 'encoding' | 'complete';
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
}

export interface RedubArgs {
  projectId: string;
  /** Absolute path of the original source video whose visuals are kept. */
  sourceVideoPath: string;
  /** Translated audio lines with their source-video time windows. */
  segments: RedubSegment[];
  /** Burn the translated text into the video as a hard subtitle. */
  subtitles?: boolean;
  /** Styling for the burned-in subtitles; falls back to defaults when omitted. */
  subtitleConfig?: SubtitleConfig;
}

export interface YtdlpDownloadArgs {
  projectId: string;
  url: string;
}

export interface YtdlpProgress {
  projectId: string;
  /** Download completion 0–100. */
  percent: number;
  phase?: 'downloading' | 'merging' | 'complete';
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
  /** 0–100 where measurable (model download); omitted for indeterminate work. */
  percent?: number;
  model?: WhisperModelName;
}

/** Tokens parsed from the `gensuite://auth-callback` deep-link after OAuth. */
export interface AuthCallbackPayload {
  accessToken: string;
  refreshToken: string;
}

/** Auto-update lifecycle forwarded from electron-updater to the renderer. */
export type UpdaterStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
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
    synthesize(args: EdgeTtsSynthesizeArgs): Promise<string>;
    kill(jobId: string): Promise<boolean>;
  };
  ffmpeg: {
    export(args: ExportArgs): Promise<string | null>;
    /** Re-dub: keep the source video's visuals, replace its audio with the translated lines. Returns the output path or null if cancelled. */
    redub(args: RedubArgs): Promise<string | null>;
    onProgress(cb: (p: FfmpegProgress) => void): () => void;
  };
  ytdlp: {
    /** Download a video by URL into <project>/source/. Returns the absolute file path. */
    download(args: YtdlpDownloadArgs): Promise<string>;
    /** Open a file picker and copy a local video/audio into <project>/source/. Returns null if cancelled. */
    import(projectId: string): Promise<string | null>;
    onProgress(cb: (p: YtdlpProgress) => void): () => void;
  };
  whisper: {
    /** Extract a 16kHz mono WAV for transcription. Returns the absolute WAV path. */
    extract(args: WhisperExtractArgs): Promise<string>;
    /** Run local whisper.cpp on the WAV. Returns timed segments. */
    transcribe(args: WhisperTranscribeArgs): Promise<TranscriptSegment[]>;
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
