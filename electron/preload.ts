import { contextBridge, ipcRenderer } from 'electron';
import { randomUUID } from 'node:crypto';
import { appErrorDefinition, isIpcResult } from '../src/shared/appErrors';
import type { IpcResult, PublicAppError } from '../src/shared/appErrors';
import type {
  GensuiteBridge,
  ProjectState,
  AppSettings,
  MediaDownloadArgs,
  AudioWriteArgs,
  AudioDownloadArgs,
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
  AuthCallbackPayload,
  UpdaterStatus,
  NarrationAnalyzeArgs,
  NarrationProgress,
  NarrationRewriteArgs,
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

function isCapCutTtsPreviewResult(value: unknown): value is CapCutTtsPreviewResult {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.audioBase64 === 'string'
    && value.audioBase64.length > 0
    && value.audioBase64.length <= 70 * 1024 * 1024
    && value.audioBase64.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value.audioBase64);
}

const bridge: GensuiteBridge = {
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
    write: (args: AudioWriteArgs) => ipcRenderer.invoke('audio:write', args),
    download: (args: AudioDownloadArgs) => ipcRenderer.invoke('audio:download', args),
  },
  edgetts: {
    voices: () => ipcRenderer.invoke('edgetts:voices'),
    synthesize: (args: EdgeTtsSynthesizeArgs) => ipcRenderer.invoke('edgetts:synthesize', args),
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
    extract: (args: WhisperExtractArgs) => ipcRenderer.invoke('whisper:extract', args),
    transcribe: (args: WhisperTranscribeArgs) => ipcRenderer.invoke('whisper:transcribe', args),
    align: (args: WhisperAlignArgs) => ipcRenderer.invoke('whisper:align', args),
    modelStatus: (args: WhisperModelStatusArgs) => ipcRenderer.invoke('whisper:modelStatus', args),
    downloadModel: (args: WhisperModelDownloadArgs) => ipcRenderer.invoke('whisper:downloadModel', args),
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
