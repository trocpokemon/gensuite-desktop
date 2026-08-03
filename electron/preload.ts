import { contextBridge, ipcRenderer } from 'electron';
import type {
  GensuiteBridge,
  ProjectState,
  AppSettings,
  MediaDownloadArgs,
  AudioWriteArgs,
  AudioDownloadArgs,
  EdgeTtsSynthesizeArgs,
  CapCutTtsSynthesizeArgs,
  CapCutTtsPreviewArgs,
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
    synthesize: (args: CapCutTtsSynthesizeArgs) => ipcRenderer.invoke('capcuttts:synthesize', args),
    preview: (args: CapCutTtsPreviewArgs) => ipcRenderer.invoke('capcuttts:preview', args),
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
    redub: (args: RedubArgs) => ipcRenderer.invoke('ffmpeg:redub', args),
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
