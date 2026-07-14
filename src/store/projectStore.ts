import { create } from 'zustand';
import type {
  ProjectState,
  ProjectSummary,
  Scene,
  ProjectSettings,
  StepId,
  ScriptEngine,
  MediaEngine,
  VoiceEngine,
  AspectRatio,
  TopicConfig,
  SubtitleConfig,
  MusicConfig,
  CharacterRef,
  TranscriptionEngine,
  WhisperModelName,
  TranscriptSegment,
} from '../shared/types';
import { DEFAULT_EDGE_VOICE } from '../providers/voice/edgeTtsCatalog';

export function uid(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_SUBTITLE: SubtitleConfig = {
  enabled: true,
  fontFamily: 'Arial',
  fontSizePct: 5,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 3,
  shadow: 1,
  bold: true,
  position: 'bottom',
  maxCharsPerLine: 42,
};

const DEFAULT_MUSIC: MusicConfig = {
  enabled: false,
  volume: 18,
};

const DEFAULT_SETTINGS: ProjectSettings = {
  scriptEngine: 'gemini',
  scriptModel: '',
  mediaEngine: 'pexels',
  voiceEngine: 'edgetts',
  aspectRatio: '16:9',
  tone: 'Kể chuyện truyền cảm',
  voiceId: '',
  transcriptionEngine: 'cloud',
  whisperModel: 'base',
  subtitle: { ...DEFAULT_SUBTITLE },
  music: { ...DEFAULT_MUSIC },
  voiceConfigs: {
    edgetts: { voiceId: DEFAULT_EDGE_VOICE, modelId: '', language: 'vi-VN', speed: 1, temperature: 1, stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, pitch: 0, volume: 100, deliveryMode: 'BALANCED' },
    genvoice: { voiceId: 'Aanya', modelId: 'genvoice-tts-2', language: 'vi-VN', speed: 1, temperature: 1.1, stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, pitch: 0, volume: 1, deliveryMode: 'BALANCED' },
    elevenlabs: { voiceId: '', modelId: 'eleven_flash_v2_5', language: 'english', speed: 1, temperature: 1, stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, pitch: 0, volume: 1, deliveryMode: 'BALANCED' },
    minimax: { voiceId: '', modelId: 'speech-2.8-turbo', language: 'english', speed: 1, temperature: 1, stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true, pitch: 0, volume: 1, deliveryMode: 'BALANCED' },
  },
};

function newProject(name = 'Dự án chưa đặt tên'): ProjectState {
  const now = new Date().toISOString();
  return {
    id: uid('p_'),
    name,
    createdAt: now,
    updatedAt: now,
    currentStep: 'topic',
    status: 'draft',
    kind: 'topic',
    idea: '',
    topic: null,
    topicCustomizations: {},
    script: { content: '', approvedContent: '', status: 'draft', versions: [] },
    scenes: [],
    storyboardSourceContent: undefined,
    storyboardTopicId: undefined,
    characterRefs: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function normalizeProject(raw: ProjectState): ProjectState {
  const legacyStep = raw.currentStep as string;
  const currentStep: StepId =
    legacyStep === 'script' ? 'content' : legacyStep === 'media' ? 'storyboard' :
      (['topic', 'content', 'storyboard', 'voice', 'timeline', 'localize'].includes(legacyStep) ? legacyStep as StepId : 'topic');
  const legacyContent = raw.script?.content || raw.scenes?.map((scene) => scene.narration).join('\n\n') || '';
  return {
    ...raw,
    currentStep,
    status: raw.status ?? 'draft',
    kind: raw.kind ?? 'topic',
    topic: raw.topic ?? null,
    topicCustomizations: raw.topicCustomizations ?? (raw.topic ? { [raw.topic.id]: raw.topic } : {}),
    script: raw.script ?? {
      content: legacyContent,
      approvedContent: '',
      status: 'draft',
      versions: [],
    },
    scenes: raw.scenes ?? [],
    characterRefs: raw.characterRefs ?? [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...raw.settings,
      subtitle: { ...DEFAULT_SUBTITLE, ...(raw.settings?.subtitle ?? {}) },
      music: { ...DEFAULT_MUSIC, ...(raw.settings?.music ?? {}) },
      // The local engine has changed over time (piper → kokoro → edgetts); migrate any project still on a retired one.
      voiceEngine: ['piper', 'kokoro'].includes(raw.settings?.voiceEngine as string) ? 'edgetts' : (raw.settings?.voiceEngine ?? DEFAULT_SETTINGS.voiceEngine),
      voiceConfigs: Object.fromEntries((Object.keys(DEFAULT_SETTINGS.voiceConfigs) as VoiceEngine[]).map((engine) => [
        engine,
        (() => {
          const merged = { ...DEFAULT_SETTINGS.voiceConfigs[engine], ...(raw.settings?.voiceConfigs?.[engine] ?? {}) };
          if (engine === 'elevenlabs' || engine === 'minimax') {
            const oldLanguage = String(merged.language || '').toLowerCase();
            if (oldLanguage === 'vi' || oldLanguage === 'vi-vn') merged.language = 'vietnamese';
            else if (oldLanguage === 'en' || oldLanguage === 'en-us' || oldLanguage === 'auto') merged.language = 'english';
          }
          return merged;
        })(),
      ])) as ProjectSettings['voiceConfigs'],
    },
  };
}

function summary(project: ProjectState): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentStep: project.currentStep,
    status: project.status,
    topicName: project.topic?.name ?? 'Chưa chọn chủ đề',
    wordCount: project.script.content.trim().split(/\s+/).filter(Boolean).length,
    sceneCount: project.scenes.length,
  };
}

interface ProjectStore {
  project: ProjectState;
  projects: ProjectSummary[];
  hydrated: boolean;
  home: boolean;
  hydrate: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  createLocalizeProject: (name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  goHome: () => Promise<void>;
  reset: () => void;
  setName: (name: string) => void;
  setIdea: (idea: string) => void;
  setTopic: (topic: TopicConfig) => void;
  saveTopicCustomization: (topic: TopicConfig) => void;
  setStep: (step: StepId) => void;
  setScriptContent: (content: string, versionLabel?: string) => void;
  approveScript: () => void;
  restoreScriptVersion: (versionId: string) => void;
  setScenes: (scenes: Scene[]) => void;
  updateScene: (id: string, patch: Partial<Scene>) => void;
  patchSettings: (patch: Partial<ProjectSettings>) => void;
  setScriptEngine: (e: ScriptEngine) => void;
  setScriptModel: (modelId: string) => void;
  setMediaEngine: (e: MediaEngine) => void;
  setVoiceEngine: (e: VoiceEngine) => void;
  setAspectRatio: (r: AspectRatio) => void;
  addCharacterRef: (ref: CharacterRef) => void;
  removeCharacterRef: (id: string) => void;
  setTranscriptionEngine: (e: TranscriptionEngine) => void;
  setWhisperModel: (model: WhisperModelName) => void;
  setSourceVideo: (path: string) => void;
  setTranscript: (segments: TranscriptSegment[]) => void;
  setLanguages: (patch: { sourceLanguage?: string; targetLanguage?: string }) => void;
  buildScenesFromTranscript: (segments: TranscriptSegment[]) => void;
  setDubbedVideo: (path: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(state: ProjectState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.gensuite?.project.save(state).catch((err) => console.error('project autosave failed', err));
  }, 500);
}

export const useProjectStore = create<ProjectStore>((set, get) => {
  const commit = (next: ProjectState) => {
    const project = { ...next, updatedAt: new Date().toISOString() };
    set({ project });
    scheduleSave(project);
  };

  return {
    project: newProject(),
    projects: [],
    hydrated: false,
    home: true,

    hydrate: async () => {
      const rows = await window.gensuite?.project.list().catch(() => []) ?? [];
      set({ projects: rows.map(normalizeProject).map(summary), hydrated: true, home: true });
    },
    refreshProjects: async () => {
      const rows = await window.gensuite.project.list();
      set({ projects: rows.map(normalizeProject).map(summary) });
    },
    createProject: async (name) => {
      const project = newProject(name?.trim() || undefined);
      await window.gensuite.project.save(project);
      set({ project, home: false });
      await get().refreshProjects();
    },
    createLocalizeProject: async (name) => {
      const project: ProjectState = {
        ...newProject(name?.trim() || 'Video dịch & lồng tiếng'),
        kind: 'localize',
        currentStep: 'localize',
      };
      await window.gensuite.project.save(project);
      set({ project, home: false });
      await get().refreshProjects();
    },
    openProject: async (id) => {
      const loaded = await window.gensuite.project.load(id);
      if (loaded) set({ project: normalizeProject(loaded), home: false });
    },
    deleteProject: async (id) => {
      await window.gensuite.project.remove(id);
      await get().refreshProjects();
    },
    duplicateProject: async (id) => {
      const loaded = await window.gensuite.project.load(id);
      if (!loaded) return;
      const source = normalizeProject(loaded);
      const now = new Date().toISOString();
      const project: ProjectState = {
        ...source,
        id: uid('p_'),
        name: `${source.name} — Bản sao`,
        createdAt: now,
        updatedAt: now,
        scenes: source.scenes.map((scene) => ({ ...scene, id: uid('s_'), imagePath: undefined, audioPath: undefined, audioDuration: undefined })),
      };
      await window.gensuite.project.save(project);
      await get().refreshProjects();
    },
    goHome: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await window.gensuite.project.save(get().project);
      }
      set({ home: true });
      await get().refreshProjects();
    },
    reset: () => commit(newProject()),
    setName: (name) => commit({ ...get().project, name }),
    setIdea: (idea) => commit({ ...get().project, idea }),
    setTopic: (topic) => {
      const project = get().project;
      const changed = project.topic?.id !== topic.id;
      commit({
        ...project,
        topic: { ...topic },
        status: changed ? 'draft' : project.status,
        scenes: changed ? [] : project.scenes,
        storyboardSourceContent: changed ? undefined : project.storyboardSourceContent,
        storyboardTopicId: changed ? undefined : project.storyboardTopicId,
        script: changed ? { ...project.script, status: 'draft' } : project.script,
        settings: { ...project.settings, tone: topic.defaultTone },
      });
    },
    saveTopicCustomization: (topic) => {
      const project = get().project;
      commit({
        ...project,
        topic: project.topic?.id === topic.id ? { ...topic } : project.topic,
        topicCustomizations: { ...project.topicCustomizations, [topic.id]: { ...topic } },
      });
    },
    setStep: (currentStep) => commit({ ...get().project, currentStep }),
    setScriptContent: (content, versionLabel) => {
      const project = get().project;
      const versions = versionLabel && project.script.content
        ? [...project.script.versions, { id: uid('v_'), content: project.script.content, createdAt: new Date().toISOString(), label: versionLabel }].slice(-20)
        : project.script.versions;
      commit({
        ...project,
        status: 'draft',
        script: { ...project.script, content, status: 'draft', versions },
      });
    },
    approveScript: () => {
      const project = get().project;
      const storyboardStale =
        project.storyboardSourceContent !== project.script.content ||
        project.storyboardTopicId !== project.topic?.id;
      commit({
        ...project,
        status: 'content-approved',
        currentStep: 'voice',
        scenes: storyboardStale ? [] : project.scenes,
        storyboardSourceContent: storyboardStale ? undefined : project.storyboardSourceContent,
        storyboardTopicId: storyboardStale ? undefined : project.storyboardTopicId,
        script: { ...project.script, approvedContent: project.script.content, status: 'approved' },
      });
    },
    restoreScriptVersion: (versionId) => {
      const project = get().project;
      const version = project.script.versions.find((item) => item.id === versionId);
      if (version) get().setScriptContent(version.content, 'Trước khi khôi phục');
    },
    setScenes: (scenes) => {
      const project = get().project;
      commit({
        ...project,
        scenes,
        status: scenes.length ? 'storyboard-ready' : project.status,
        storyboardSourceContent: scenes.length ? project.script.approvedContent : undefined,
        storyboardTopicId: scenes.length ? project.topic?.id : undefined,
      });
    },
    updateScene: (id, patch) => commit({
      ...get().project,
      scenes: get().project.scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene),
    }),
    patchSettings: (patch) => commit({ ...get().project, settings: { ...get().project.settings, ...patch } }),
    setScriptEngine: (scriptEngine) => commit({ ...get().project, settings: { ...get().project.settings, scriptEngine } }),
    setScriptModel: (scriptModel) => commit({ ...get().project, settings: { ...get().project.settings, scriptModel } }),
    setMediaEngine: (mediaEngine) => commit({ ...get().project, settings: { ...get().project.settings, mediaEngine } }),
    setVoiceEngine: (voiceEngine) => commit({ ...get().project, settings: { ...get().project.settings, voiceEngine } }),
    setAspectRatio: (aspectRatio) => commit({ ...get().project, settings: { ...get().project.settings, aspectRatio } }),
    addCharacterRef: (ref) => commit({ ...get().project, characterRefs: [...get().project.characterRefs, ref].slice(-4) }),
    removeCharacterRef: (id) => commit({ ...get().project, characterRefs: get().project.characterRefs.filter((ref) => ref.id !== id) }),
    setTranscriptionEngine: (transcriptionEngine) => commit({ ...get().project, settings: { ...get().project.settings, transcriptionEngine } }),
    setWhisperModel: (whisperModel) => commit({ ...get().project, settings: { ...get().project.settings, whisperModel } }),
    setSourceVideo: (sourceVideoPath) => commit({ ...get().project, sourceVideoPath }),
    setTranscript: (segments) => commit({ ...get().project, transcript: segments }),
    setLanguages: (patch) => commit({ ...get().project, ...patch }),
    setDubbedVideo: (dubbedVideoPath) => commit({ ...get().project, dubbedVideoPath }),
    // Re-dub bridge: each translated segment becomes one Scene, keeping its source
    // timing. The scene flows through the existing voice → storyboard → timeline
    // pipeline exactly like a topic project.
    buildScenesFromTranscript: (segments) => {
      const scenes: Scene[] = segments
        .filter((seg) => seg.text.trim())
        .map((seg) => ({
          id: uid('s_'),
          narration: seg.text.trim(),
          imagePrompt: '',
          keyword: '',
          sourceStart: seg.start,
          sourceEnd: seg.end,
          visualType: 'upload',
        }));
      get().setScenes(scenes);
    },
  };
});
