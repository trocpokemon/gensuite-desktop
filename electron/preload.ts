import { contextBridge, ipcRenderer } from 'electron';
import { randomUUID } from 'node:crypto';
import { appErrorDefinition, isIpcResult } from '../src/shared/appErrors';
import type { IpcResult, PublicAppError } from '../src/shared/appErrors';
import type {
  LocalizeCheckpointReadArgs,
  LocalizeCheckpointWriteArgs,
  LocalizeJobIdentity,
  LocalizeJobManifest,
  LocalizeJobStartArgs,
  LocalizeJobUpdateArgs,
} from '../src/shared/localizeJob';
import type {
  GensuiteBridge,
  ProjectState,
  AppSettings,
  MediaDownloadArgs,
  AudioWriteArgs,
  AudioDownloadArgs,
  AudioPersistResult,
  AudioAssembleArgs,
  AudioProbeArgs,
  EdgeTtsSynthesizeResult,
  EdgeTtsVoice,
  EdgeTtsSynthesizeArgs,
  CapCutTtsSynthesizeArgs,
  CapCutTtsSynthesizeResult,
  CapCutTtsPreviewArgs,
  CapCutTtsPreviewResult,
  ExportArgs,
  RedubArgs,
  FfmpegProgress,
  TopicConfig,
  YtdlpDownloadArgs,
  YtdlpProgress,
  WhisperExtractArgs,
  WhisperTranscribeArgs,
  WhisperAlignArgs,
  WhisperModelStatusArgs,
  WhisperModelDownloadArgs,
  WhisperProgress,
  TranscriptSegment,
  SubtitleWordTiming,
  AuthCallbackPayload,
  UpdaterStatus,
  NarrationAnalyzeArgs,
  NarrationProgress,
  NarrationRewriteArgs,
  CapCutDraftExportArgs,
  CapCutDraftExportResult,
} from '../src/shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyPublicError(error: PublicAppError): PublicAppError {
  return {
    kind: 'app-error-v1',
    code: error.code,
    stage: error.stage,
    cause: error.cause,
    retryable: error.retryable,
    diagnosticId: error.diagnosticId,
    context: error.context ? { ...error.context } : undefined,
  };
}

function bridgeFailure<T>(): IpcResult<T> {
  const code = 'DESKTOP_BRIDGE_UNAVAILABLE' as const;
  const definition = appErrorDefinition(code);
  const diagnosticId = `GS-${randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    ipcRenderer.send('diagnostics:preload-failure', { diagnosticId, code });
  } catch {
    // The bridge itself may be unavailable; returning the safe payload is the
    // final fallback and must not depend on another IPC send succeeding.
  }
  return {
    ok: false,
    error: {
      kind: 'app-error-v1',
      code,
      stage: definition.stage,
      cause: definition.cause,
      retryable: definition.retryable,
      diagnosticId,
    },
  };
}

async function invokeStructured<T>(
  channel: string,
  args: unknown,
  isValue: (value: unknown) => value is T,
): Promise<IpcResult<T>> {
  try {
    const result: unknown = await ipcRenderer.invoke(channel, args);
    if (isIpcResult(result, isValue)) {
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: copyPublicError(result.error) };
    }
  } catch {
    // Raw IPC exceptions never cross into the renderer.
  }
  return bridgeFailure<T>();
}

function isCapCutTtsResult(value: unknown): value is CapCutTtsSynthesizeResult {
  return isRecord(value)
    && Object.keys(value).length === 2
    && typeof value.audioPath === 'string'
    && value.audioPath.trim().length > 0
    && typeof value.durationSec === 'number'
    && Number.isFinite(value.durationSec)
    && value.durationSec > 0;
}

function isAudioPersistResult(value: unknown): value is AudioPersistResult {
  return isRecord(value)
    && Object.keys(value).length === 2
    && typeof value.audioPath === 'string' && value.audioPath.trim().length > 0
    && typeof value.durationSec === 'number' && Number.isFinite(value.durationSec) && value.durationSec > 0;
}

function isEdgeTtsResult(value: unknown): value is EdgeTtsSynthesizeResult {
  if (!isRecord(value) || !isAudioPersistResult({ audioPath: value.audioPath, durationSec: value.durationSec })) return false;
  if (value.wordTimings === undefined) return Object.keys(value).every((key) => ['audioPath', 'durationSec'].includes(key));
  return Object.keys(value).every((key) => ['audioPath', 'durationSec', 'wordTimings'].includes(key))
    && isSubtitleWordTimings(value.wordTimings);
}

function isEdgeTtsVoices(value: unknown): value is EdgeTtsVoice[] {
  return Array.isArray(value) && value.every((voice) => isRecord(voice)
    && Object.keys(voice).every((key) => ['shortName', 'friendlyName', 'locale', 'gender'].includes(key))
    && ['shortName', 'friendlyName', 'locale', 'gender'].every((key) => typeof voice[key] === 'string'));
}

function isCapCutTtsPreviewResult(value: unknown): value is CapCutTtsPreviewResult {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.audioBase64 === 'string'
    && value.audioBase64.length > 0
    && value.audioBase64.length <= 70 * 1024 * 1024
    && value.audioBase64.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value.audioBase64);
}

function isCapCutDraftExportResult(value: unknown): value is CapCutDraftExportResult {
  return isRecord(value)
    && Object.keys(value).length === 2
    && typeof value.draftPath === 'string' && value.draftPath.trim().length > 0
    && typeof value.projectName === 'string' && value.projectName.trim().length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLocalizeJob(value: unknown): value is LocalizeJobManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.projectId !== 'string'
    || typeof value.operationId !== 'string' || typeof value.status !== 'string'
    || typeof value.activeStage !== 'string' || !isRecord(value.steps)) return false;
  const steps = value.steps;
  return ['download', 'recognition', 'translation', 'voice', 'capcut'].every((stage) => {
    const step = steps[stage];
    return isRecord(step) && step.stage === stage && typeof step.status === 'string'
      && typeof step.percent === 'number' && Number.isFinite(step.percent);
  });
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 20_000 && value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 20_000
    && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isTranscriptSegments(value: unknown): value is TranscriptSegment[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && Object.keys(item).every((key) => ['id', 'start', 'end', 'text'].includes(key))
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0
    && typeof item.end === 'number' && Number.isFinite(item.end) && item.end > item.start
    && typeof item.text === 'string' && item.text.trim().length > 0);
}

function isSubtitleWordTimings(value: unknown): value is SubtitleWordTiming[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && Object.keys(item).every((key) => ['word', 'start', 'end'].includes(key))
    && typeof item.word === 'string' && item.word.trim().length > 0
    && typeof item.start === 'number' && Number.isFinite(item.start) && item.start >= 0
    && typeof item.end === 'number' && Number.isFinite(item.end) && item.end > item.start);
}

function isWhisperModelStatus(value: unknown): value is import('../src/shared/types').WhisperModelStatus {
  return isRecord(value)
    && Object.keys(value).every((key) => ['model', 'present', 'path'].includes(key))
    && ['tiny', 'base', 'small', 'medium'].includes(String(value.model))
    && typeof value.present === 'boolean'
    && typeof value.path === 'string';
}

const bridge: GensuiteBridge = {
  diagnostics: {
    record: (error: PublicAppError) => ipcRenderer.send('diagnostics:client-failure', copyPublicError(error)),
    copyFailure: (error: PublicAppError, occurredAt: string) => invokeStructured(
      'diagnostics:copy-failure',
      { error: copyPublicError(error), occurredAt },
      (value): value is boolean => typeof value === 'boolean',
    ),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),
    showItemInFolder: (filePath: string) => ipcRenderer.send('shell:showItemInFolder', filePath),
    selectDirectory: (defaultPath?: string) => ipcRenderer.invoke('shell:selectDirectory', defaultPath),
  },
  hardware: {
    scan: () => ipcRenderer.invoke('hardware:scan'),
  },
  project: {
    save: (state: ProjectState) => ipcRenderer.invoke('project:save', state),
    load: (id: string) => ipcRenderer.invoke('project:load', id),
    loadLast: () => ipcRenderer.invoke('project:loadLast'),
    list: () => ipcRenderer.invoke('project:list'),
    remove: (id: string) => ipcRenderer.invoke('project:remove', id),
    dir: (id: string) => ipcRenderer.invoke('project:dir', id),
    size: (id: string) => ipcRenderer.invoke('project:size', id),
    openDir: (id: string) => ipcRenderer.invoke('project:openDir', id),
    cleanup: (id: string) => ipcRenderer.invoke('project:cleanup', id),
  },
  topics: {
    load: () => ipcRenderer.invoke('topics:load'),
    save: (topics: TopicConfig[]) => ipcRenderer.invoke('topics:save', topics),
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: AppSettings) => ipcRenderer.invoke('settings:save', settings),
  },
  media: {
    download: (args: MediaDownloadArgs) => ipcRenderer.invoke('media:download', args),
  },
  audio: {
    write: (args: AudioWriteArgs) => invokeStructured('audio:write', args, isAudioPersistResult),
    download: (args: AudioDownloadArgs) => invokeStructured('audio:download', args, isAudioPersistResult),
    assemble: (args: AudioAssembleArgs) => invokeStructured('audio:assemble', args, isAudioPersistResult),
    probe: (args: AudioProbeArgs) => invokeStructured('audio:probe', args, isAudioPersistResult),
  },
  edgetts: {
    voices: () => invokeStructured('edgetts:voices', undefined, isEdgeTtsVoices),
    synthesize: (args: EdgeTtsSynthesizeArgs) => invokeStructured('edgetts:synthesize', args, isEdgeTtsResult),
    kill: (jobId: string) => ipcRenderer.invoke('edgetts:kill', jobId),
  },
  capcuttts: {
    synthesize: (args: CapCutTtsSynthesizeArgs) => invokeStructured('capcuttts:synthesize', args, isCapCutTtsResult),
    preview: (args: CapCutTtsPreviewArgs) => invokeStructured('capcuttts:preview', args, isCapCutTtsPreviewResult),
    kill: (jobId: string) => ipcRenderer.invoke('capcuttts:kill', jobId),
  },
  music: {
    import: (projectId: string) => ipcRenderer.invoke('music:import', projectId),
  },
  characters: {
    import: (projectId: string) => ipcRenderer.invoke('characters:import', projectId),
  },
  ffmpeg: {
    export: (args: ExportArgs) => ipcRenderer.invoke('ffmpeg:export', args),
    redub: (args: RedubArgs): Promise<IpcResult<string | null>> => invokeStructured(
      'ffmpeg:redub',
      args,
      (value): value is string | null => value === null || typeof value === 'string',
    ),
    onProgress: (cb: (p: FfmpegProgress) => void) => {
      const listener = (_e: unknown, p: FfmpegProgress) => cb(p);
      ipcRenderer.on('ffmpeg:progress', listener);
      return () => ipcRenderer.removeListener('ffmpeg:progress', listener);
    },
  },
  capcut: {
    launch: () => invokeStructured(
      'capcut:launch',
      undefined,
      (value): value is boolean => value === true,
    ),
    exportDraft: (args: CapCutDraftExportArgs) => invokeStructured(
      'capcut:exportDraft',
      args,
      isCapCutDraftExportResult,
    ),
    selectDraftsDirectory: () => invokeStructured(
      'capcut:selectDraftsDirectory',
      undefined,
      (value): value is string | null => value === null || (typeof value === 'string' && value.trim().length > 0),
    ),
  },
  localize: {
    start: (args: LocalizeJobStartArgs) => invokeStructured('localize:start', args, isLocalizeJob),
    update: (args: LocalizeJobUpdateArgs) => invokeStructured('localize:update', args, isLocalizeJob),
    get: (projectId: string) => invokeStructured(
      'localize:get', projectId,
      (value): value is LocalizeJobManifest | null => value === null || isLocalizeJob(value),
    ),
    list: () => invokeStructured(
      'localize:list', undefined,
      (value): value is LocalizeJobManifest[] => Array.isArray(value) && value.every(isLocalizeJob),
    ),
    cancel: (identity: LocalizeJobIdentity) => invokeStructured('localize:cancel', identity, isLocalizeJob),
    readCheckpoint: (args: LocalizeCheckpointReadArgs) => invokeStructured(
      'localize:checkpoint-read', args,
      (value): value is unknown | null => value === null || isJsonValue(value),
    ),
    writeCheckpoint: (args: LocalizeCheckpointWriteArgs) => invokeStructured(
      'localize:checkpoint-write', args,
      (value): value is boolean => typeof value === 'boolean',
    ),
    removeCheckpoint: (args: LocalizeCheckpointReadArgs) => invokeStructured(
      'localize:checkpoint-remove', args,
      (value): value is boolean => typeof value === 'boolean',
    ),
    onJob: (cb: (job: LocalizeJobManifest) => void) => {
      const listener = (_event: unknown, job: unknown) => { if (isLocalizeJob(job)) cb(job); };
      ipcRenderer.on('localize:job-event', listener);
      return () => ipcRenderer.removeListener('localize:job-event', listener);
    },
  },
  narration: {
    analyze: (args: NarrationAnalyzeArgs) => ipcRenderer.invoke('narration:analyze', args),
    rewrite: (args: NarrationRewriteArgs) => ipcRenderer.invoke('narration:rewrite', args),
    onProgress: (cb: (p: NarrationProgress) => void) => {
      const listener = (_e: unknown, p: NarrationProgress) => cb(p);
      ipcRenderer.on('narration:progress', listener);
      return () => ipcRenderer.removeListener('narration:progress', listener);
    },
  },
  ytdlp: {
    download: (args: YtdlpDownloadArgs) => ipcRenderer.invoke('ytdlp:download', args),
    loginDouyin: () => ipcRenderer.invoke('ytdlp:douyinLogin'),
    clearDouyinSession: () => ipcRenderer.invoke('ytdlp:douyinClearSession'),
    loginTikTok: () => ipcRenderer.invoke('ytdlp:tiktokLogin'),
    clearTikTokSession: () => ipcRenderer.invoke('ytdlp:tiktokClearSession'),
    import: (projectId: string) => ipcRenderer.invoke('ytdlp:import', projectId),
    importMany: (projectId: string) => ipcRenderer.invoke('ytdlp:importMany', projectId),
    onProgress: (cb: (p: YtdlpProgress) => void) => {
      const listener = (_e: unknown, p: YtdlpProgress) => cb(p);
      ipcRenderer.on('ytdlp:progress', listener);
      return () => ipcRenderer.removeListener('ytdlp:progress', listener);
    },
  },
  files: {
    pickText: () => ipcRenderer.invoke('files:pickText'),
    saveText: (args) => ipcRenderer.invoke('files:saveText', args),
    saveCopy: (args) => ipcRenderer.invoke('files:saveCopy', args),
  },
  whisper: {
    extract: (args: WhisperExtractArgs) => invokeStructured('whisper:extract', args, isNonEmptyString),
    transcribe: (args: WhisperTranscribeArgs) => invokeStructured('whisper:transcribe', args, isTranscriptSegments),
    align: (args: WhisperAlignArgs) => invokeStructured('whisper:align', args, isSubtitleWordTimings),
    modelStatus: (args: WhisperModelStatusArgs) => invokeStructured('whisper:modelStatus', args, isWhisperModelStatus),
    downloadModel: (args: WhisperModelDownloadArgs) => invokeStructured('whisper:downloadModel', args, isNonEmptyString),
    cancel: (projectId: string) => ipcRenderer.invoke('whisper:cancel', projectId),
    onProgress: (cb: (p: WhisperProgress) => void) => {
      const listener = (_e: unknown, p: WhisperProgress) => cb(p);
      ipcRenderer.on('whisper:progress', listener);
      return () => ipcRenderer.removeListener('whisper:progress', listener);
    },
  },
  auth: {
    onCallback: (cb: (payload: AuthCallbackPayload) => void) => {
      const listener = (_e: unknown, payload: AuthCallbackPayload) => cb(payload);
      ipcRenderer.on('auth:callback', listener);
      return () => ipcRenderer.removeListener('auth:callback', listener);
    },
  },
  updater: {
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    onStatus: (cb: (status: UpdaterStatus) => void) => {
      const listener = (_e: unknown, status: UpdaterStatus) => cb(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
    check: () => ipcRenderer.send('updater:check'),
    download: () => ipcRenderer.send('updater:download'),
    install: () => ipcRenderer.send('updater:install'),
  },
};

contextBridge.exposeInMainWorld('gensuite', bridge);
