import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronDown, Copy, Loader2, Pause, Play, RefreshCw, Search, SlidersHorizontal, Upload, User, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { useSettingsStore } from '../store/settingsStore';
import { cloneGenSuiteVoice, getGenSuiteVoicePreview, listGenSuiteModels, listGenSuiteVoicePage, listGenSuiteVoices } from '../providers/voice/GenSuiteVoiceAdapter';
import type { GenSuiteModel, GenSuiteVoice, GenSuiteVoiceEngine } from '../providers/voice/GenSuiteVoiceAdapter';
import { missingKeyService, errorMessage } from '../providers/errors';
import type { ProjectSettings, VoiceConfig, VoiceEngine } from '../shared/types';
import { CompactFilter, LanguageDropdown, ModelPickerSheet } from './VoiceSettingControls';
import { EDGE_TTS_FALLBACK_VOICES, localeLabel, edgeVoiceName } from '../providers/voice/edgeTtsCatalog';
import type { EdgeTtsVoice } from '../shared/types';

interface Props {
  /** Rendered under the config controls (e.g. a host-specific action button). */
  footer?: ReactNode;
  /** Surface a missing-key notice to the host so it can render the settings prompt. */
  onMissingKey?: (service: string | null) => void;
}

function edgeVoiceToOption(voice: EdgeTtsVoice): GenSuiteVoice {
  return {
    voiceId: voice.shortName,
    name: edgeVoiceName(voice),
    category: `${voice.gender === 'Female' ? 'Nữ' : 'Nam'} · ${localeLabel(voice.locale)}`,
    labels: { gender: voice.gender, language: voice.locale },
  };
}
const EDGE_VOICE_OPTIONS: GenSuiteVoice[] = EDGE_TTS_FALLBACK_VOICES.map(edgeVoiceToOption);
const EDGE_MODEL_OPTIONS: GenSuiteModel[] = [];

let edgeVoiceCache: GenSuiteVoice[] | null = null;
let catalogCacheKey = '';
let modelCatalogCache: Record<GenSuiteVoiceEngine, GenSuiteModel[]> | null = null;
const voiceCatalogCache: Partial<Record<GenSuiteVoiceEngine, GenSuiteVoice[]>> = {};
// Remembers the metadata of any voice the user has picked, keyed by voiceId. The
// explore tab's voices aren't in the system `voices` list, so without this the
// selected-voice label can't resolve a name and shows "Chưa chọn giọng".
const selectedVoiceMetaCache = new Map<string, GenSuiteVoice>();

const GENVOICE_LANGUAGES = [
  ['vi-VN', 'Tiếng Việt · beta'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['zh-CN', 'Chinese (Mandarin)'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['fr-FR', 'French'],
  ['de-DE', 'German'], ['es-ES', 'Spanish'], ['pt-BR', 'Portuguese (BR)'], ['it-IT', 'Italian'],
  ['nl-NL', 'Dutch'], ['pl-PL', 'Polish'], ['ru-RU', 'Russian'], ['hi-IN', 'Hindi'], ['ar-SA', 'Arabic'],
  ['he-IL', 'Hebrew'], ['yue', 'Cantonese · beta'], ['th-TH', 'Thai · beta'], ['id-ID', 'Indonesian · beta'],
  ['tr-TR', 'Turkish · beta'], ['uk-UA', 'Ukrainian · beta'], ['cs-CZ', 'Czech · beta'], ['sv-SE', 'Swedish · beta'],
  ['fi-FI', 'Finnish · beta'], ['da-DK', 'Danish · beta'], ['nb-NO', 'Norwegian · beta'], ['el-GR', 'Greek · beta'],
  ['ro-RO', 'Romanian · beta'], ['hu-HU', 'Hungarian · beta'], ['bg-BG', 'Bulgarian · beta'], ['fa-IR', 'Persian · beta'],
  ['fil-PH', 'Filipino · beta'], ['ms-MY', 'Malay · beta'], ['ta-IN', 'Tamil · beta'], ['te-IN', 'Telugu · beta'],
  ['bn-BD', 'Bengali · beta'], ['ur-PK', 'Urdu · beta'], ['sw', 'Swahili · beta'], ['af-ZA', 'Afrikaans · beta'],
  ['cy', 'Welsh · beta'], ['is-IS', 'Icelandic · beta'],
] as const;
const GENMAX_LANGUAGES = [
  ['english', 'English'], ['vietnamese', 'Tiếng Việt'], ['chinese', 'Chinese (Mandarin)'],
  ['cantonese', 'Cantonese'], ['japanese', 'Japanese'], ['korean', 'Korean'], ['thai', 'Thai'],
  ['indonesian', 'Indonesian'], ['malay', 'Malay'], ['filipino', 'Filipino'], ['hindi', 'Hindi'],
  ['tamil', 'Tamil'], ['arabic', 'Arabic'], ['persian', 'Persian'], ['hebrew', 'Hebrew'],
  ['turkish', 'Turkish'], ['french', 'French'], ['german', 'German'], ['spanish', 'Spanish'],
  ['catalan', 'Catalan'], ['portuguese', 'Portuguese'], ['italian', 'Italian'], ['dutch', 'Dutch'],
  ['russian', 'Russian'], ['ukrainian', 'Ukrainian'], ['polish', 'Polish'], ['czech', 'Czech'],
  ['slovak', 'Slovak'], ['hungarian', 'Hungarian'], ['romanian', 'Romanian'], ['bulgarian', 'Bulgarian'],
  ['greek', 'Greek'], ['croatian', 'Croatian'], ['slovenian', 'Slovenian'], ['danish', 'Danish'],
  ['swedish', 'Swedish'], ['norwegian', 'Norwegian'], ['nynorsk', 'Nynorsk'], ['finnish', 'Finnish'],
  ['afrikaans', 'Afrikaans'],
] as const;
// Exposed so hosts (SoundStage) can validate a config's language before synthesis
// without duplicating the catalog.
export const GENMAX_LANGUAGE_IDS: readonly string[] = GENMAX_LANGUAGES.map(([id]) => id);
const GENMAX_COUNTRIES: Record<string, string> = {
  english: 'us', vietnamese: 'vn', chinese: 'cn', cantonese: 'hk', japanese: 'jp', korean: 'kr', thai: 'th', indonesian: 'id', malay: 'my', filipino: 'ph', hindi: 'in', tamil: 'in', arabic: 'sa', persian: 'ir', hebrew: 'il', turkish: 'tr', french: 'fr', german: 'de', spanish: 'es', catalan: 'es', portuguese: 'pt', italian: 'it', dutch: 'nl', russian: 'ru', ukrainian: 'ua', polish: 'pl', czech: 'cz', slovak: 'sk', hungarian: 'hu', romanian: 'ro', bulgarian: 'bg', greek: 'gr', croatian: 'hr', slovenian: 'si', danish: 'dk', swedish: 'se', norwegian: 'no', nynorsk: 'no', finnish: 'fi', afrikaans: 'za',
};
const SPECIAL_COUNTRIES: Record<string, string> = { yue: 'hk', sw: 'tz', cy: 'gb' };
const ALL_FILTER = { value: '', label: 'Tất cả' };
const EXPLORE_LANGUAGES = [ALL_FILTER, { value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'zh', label: 'Chinese' }, { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' }, { value: 'fr', label: 'French' }, { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' }, { value: 'pt', label: 'Portuguese' }, { value: 'hi', label: 'Hindi' }, { value: 'ar', label: 'Arabic' }];
const EXPLORE_ACCENTS = [ALL_FILTER, { value: 'american', label: 'American' }, { value: 'british', label: 'British' }, { value: 'australian', label: 'Australian' }, { value: 'african', label: 'African' }, { value: 'indian', label: 'Indian' }];
const EXPLORE_QUALITIES = [ALL_FILTER, { value: 'professional', label: 'Professional' }, { value: 'high_quality', label: 'High quality' }, { value: 'premade', label: 'Premade' }];
const EXPLORE_GENDERS = [ALL_FILTER, { value: 'male', label: 'Nam' }, { value: 'female', label: 'Nữ' }];
const EXPLORE_USE_CASES = [ALL_FILTER, { value: 'narration', label: 'Kể chuyện' }, { value: 'conversational', label: 'Hội thoại' }, { value: 'characters_animation', label: 'Nhân vật & hoạt hình' }, { value: 'social_media', label: 'Mạng xã hội' }, { value: 'entertainment_tv', label: 'Giải trí & TV' }, { value: 'advertisement', label: 'Quảng cáo' }, { value: 'informative_educational', label: 'Giáo dục' }];

function audioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const finish = (value: number) => { URL.revokeObjectURL(url); resolve(value); };
    audio.addEventListener('loadedmetadata', () => finish(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
    audio.addEventListener('error', () => finish(0), { once: true });
    audio.src = url;
  });
}

function RangeField({ label, value, min, max, step, hint, onChange }: {
  label: string; value: number; min: number; max: number; step: number; hint?: string; onChange: (value: number) => void;
}) {
  return <label className="block space-y-2"><span className="flex items-center justify-between text-[10px] font-black uppercase tracking-[0.18em] text-white/40"><span>{label}</span><span className="font-mono text-white">{value.toFixed(step < 0.1 ? 2 : 1)}</span></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-white/5 accent-emerald-400" />{hint && <span className="block text-[10px] leading-4 text-white/25">{hint}</span>}</label>;
}

const ENGINE_OPTIONS: Array<{ id: VoiceEngine; label: string; mark: string; thumbnail: string; description: string; paid: boolean }> = [
  { id: 'edgetts', label: 'Edge TTS', mark: 'E', thumbnail: 'provider-thumbnails/edgetts.webp', description: 'Giọng miễn phí, không cần API key, hỗ trợ ~90 ngôn ngữ.', paid: false },
  { id: 'genvoice', label: 'GenVoice', mark: 'G', thumbnail: 'provider-thumbnails/genvoice.webp', description: 'Giọng đa ngôn ngữ qua GenSuite API, hỗ trợ clone giọng cá nhân.', paid: true },
  { id: 'elevenlabs', label: 'ElevenLabs', mark: 'II', thumbnail: 'provider-thumbnails/elevenlabs.webp', description: 'Giọng tự nhiên, giàu cảm xúc với thư viện cộng đồng phong phú.', paid: true },
  { id: 'minimax', label: 'MiniMax', mark: 'M', thumbnail: 'provider-thumbnails/minimax.webp', description: 'Giọng cloud biểu cảm, sử dụng các giọng clone đã đồng bộ.', paid: true },
];

// Shared voice provider/voice/model/param configuration. Extracted from SoundStage
// so the localize studio offers the exact same engine + voice picker. Reads and
// writes voice settings straight to the active project's store.
export function VoiceConfigPanel({ footer, onMissingKey }: Props) {
  const project = useProjectStore((state) => state.project);
  const setScenes = useProjectStore((state) => state.setScenes);
  const patchSettings = useProjectStore((state) => state.patchSettings);
  const setVoiceEngine = useProjectStore((state) => state.setVoiceEngine);
  const keys = useSettingsStore((state) => state.keys);
  const engine = project.settings.voiceEngine;
  const config = project.settings.voiceConfigs[engine];

  const [catalogModels, setCatalogModels] = useState<Record<GenSuiteVoiceEngine, GenSuiteModel[]>>({ genvoice: [], elevenlabs: [], minimax: [] });
  const [voices, setVoices] = useState<GenSuiteVoice[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [voiceQuery, setVoiceQuery] = useState('');
  const [edgeLanguage, setEdgeLanguage] = useState('');
  const [voiceLibraryOpen, setVoiceLibraryOpen] = useState(false);
  const [librarySource, setLibrarySource] = useState<'system' | 'explore'>('system');
  const [exploreVoices, setExploreVoices] = useState<GenSuiteVoice[]>([]);
  const [exploreBusy, setExploreBusy] = useState(false);
  const [exploreHasMore, setExploreHasMore] = useState(false);
  const [exploreNextPage, setExploreNextPage] = useState<number | null>(null);
  const [exploreError, setExploreError] = useState('');
  const [exploreLanguage, setExploreLanguage] = useState('');
  const [exploreAccent, setExploreAccent] = useState('');
  const [exploreQuality, setExploreQuality] = useState('');
  const [exploreGender, setExploreGender] = useState('');
  const [exploreUseCase, setExploreUseCase] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneGender, setCloneGender] = useState('female');
  const [cloneLanguage, setCloneLanguage] = useState('');
  const [cloneRights, setCloneRights] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneMessage, setCloneMessage] = useState('');
  const [cloneError, setCloneError] = useState('');
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [previewLoadingVoiceId, setPreviewLoadingVoiceId] = useState<string | null>(null);
  const [previewErrorVoiceId, setPreviewErrorVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const dynamicPreviewUrlsRef = useRef<Map<string, string>>(new Map());
  const voiceLibraryScrollRef = useRef<HTMLDivElement | null>(null);
  const exploreLoadMoreRef = useRef<HTMLDivElement | null>(null);

  const flagMissingKey = (service: string | null) => onMissingKey?.(service);

  useEffect(() => {
    if (catalogCacheKey !== keys.gensuiteApiKey) {
      catalogCacheKey = keys.gensuiteApiKey;
      for (const cachedEngine of Object.keys(voiceCatalogCache) as GenSuiteVoiceEngine[]) delete voiceCatalogCache[cachedEngine];
      modelCatalogCache = null;
    }
    if (engine === 'edgetts') {
      if (edgeVoiceCache) {
        setVoices(edgeVoiceCache);
        setCatalogBusy(false);
        setCatalogError('');
        return;
      }
      setVoices(EDGE_VOICE_OPTIONS);
      let active = true;
      setCatalogBusy(true);
      setCatalogError('');
      window.gensuite.edgetts.voices().then((list) => {
        if (!active) return;
        const options = list.map(edgeVoiceToOption);
        edgeVoiceCache = options.length ? options : EDGE_VOICE_OPTIONS;
        setVoices(edgeVoiceCache);
      }).catch(() => {
        if (!active) return;
        setVoices(EDGE_VOICE_OPTIONS);
      }).finally(() => active && setCatalogBusy(false));
      return () => { active = false; };
    }
    const cachedModels = modelCatalogCache;
    const cachedVoices = voiceCatalogCache[engine];
    if (cachedModels && cachedVoices) {
      setCatalogModels(cachedModels);
      setVoices(cachedVoices);
      setCatalogBusy(false);
      setCatalogError('');
      return;
    }
    let active = true;
    setCatalogBusy(true);
    setCatalogError('');
    Promise.all([
      cachedModels ? Promise.resolve(cachedModels) : listGenSuiteModels(keys.gensuiteApiKey),
      cachedVoices ? Promise.resolve(cachedVoices) : listGenSuiteVoices(keys.gensuiteApiKey, engine),
    ]).then(([models, nextVoices]) => {
      modelCatalogCache = models;
      voiceCatalogCache[engine] = nextVoices;
      if (!active) return;
      setCatalogModels(models);
      setVoices(nextVoices);
      const current = project.settings.voiceConfigs[engine];
      const validModel = models[engine].some((item) => item.id === current.modelId);
      const validVoice = nextVoices.some((item) => item.voiceId === current.voiceId);
      const patch: Partial<VoiceConfig> = {};
      if (!validModel && models[engine][0]) patch.modelId = models[engine][0].id;
      if (!validVoice && nextVoices[0]) patch.voiceId = nextVoices[0].voiceId;
      if (Object.keys(patch).length) {
        patchSettings({ voiceConfigs: {
          ...project.settings.voiceConfigs,
          [engine]: { ...current, ...patch },
        } } as Partial<ProjectSettings>);
      }
    }).catch((error) => {
      if (!active) return;
      const service = missingKeyService(error);
      if (service) flagMissingKey(service);
      setCatalogError(service ? 'Cần GenSuite API key để tải model và giọng.' : errorMessage(error));
      setVoices([]);
    }).finally(() => active && setCatalogBusy(false));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, keys.gensuiteApiKey, catalogRefresh]);

  useEffect(() => {
    if (!voiceLibraryOpen || engine !== 'elevenlabs' || librarySource !== 'explore') return;
    let active = true;
    setExploreBusy(true);
    const timer = window.setTimeout(() => {
      setExploreError('');
      listGenSuiteVoicePage(keys.gensuiteApiKey, 'elevenlabs', {
        type: 'explore', page: 1, pageSize: 30, search: voiceQuery,
        language: exploreLanguage, accent: exploreAccent, category: exploreQuality,
        gender: exploreGender, useCase: exploreUseCase,
      }).then((result) => {
        if (!active) return;
        setExploreVoices(result.voices);
        setExploreHasMore(result.hasMore);
        setExploreNextPage(result.nextPage);
      }).catch((error) => active && setExploreError(errorMessage(error)))
        .finally(() => active && setExploreBusy(false));
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [voiceLibraryOpen, engine, librarySource, voiceQuery, keys.gensuiteApiKey, exploreLanguage, exploreAccent, exploreQuality, exploreGender, exploreUseCase]);

  const models = engine === 'edgetts' ? EDGE_MODEL_OPTIONS : catalogModels[engine];
  const edgeLanguageOptions = useMemo(() => {
    if (engine !== 'edgetts') return [ALL_FILTER];
    const locales = new Map<string, string>();
    for (const voice of voices) {
      const locale = voice.labels?.language;
      if (locale && !locales.has(locale)) locales.set(locale, localeLabel(locale));
    }
    const sorted = [...locales.entries()].sort((a, b) => a[1].localeCompare(b[1], 'vi'));
    return [ALL_FILTER, ...sorted.map(([value, label]) => ({ value, label }))];
  }, [engine, voices]);
  const filteredVoices = useMemo(() => {
    const query = voiceQuery.trim().toLowerCase();
    let list = voices;
    if (engine === 'edgetts' && edgeLanguage) list = list.filter((voice) => voice.labels?.language === edgeLanguage);
    return query ? list.filter((voice) => `${voice.name} ${voice.voiceId} ${voice.category || ''}`.toLowerCase().includes(query)) : list;
  }, [voiceQuery, voices, engine, edgeLanguage]);
  const visibleLibraryVoices = engine === 'elevenlabs' && librarySource === 'explore' ? exploreVoices : filteredVoices;
  const selectedVoice = voices.find((voice) => voice.voiceId === config.voiceId)
    || selectedVoiceMetaCache.get(config.voiceId);
  const genmaxLanguages = engine === 'elevenlabs' && config.modelId !== 'eleven_v3'
    ? GENMAX_LANGUAGES.filter(([id]) => id !== 'vietnamese')
    : GENMAX_LANGUAGES;
  const genvoiceLanguageOptions = GENVOICE_LANGUAGES.map(([value, label]) => ({
    value, label: `${label} (${value})`, countryCode: SPECIAL_COUNTRIES[value] || value.split('-')[1]?.toLowerCase() || value.toLowerCase(),
  }));
  const genmaxLanguageOptions = genmaxLanguages.map(([value, label]) => ({
    value, label, countryCode: GENMAX_COUNTRIES[value] || 'us',
  }));
  const allGenmaxLanguageOptions = GENMAX_LANGUAGES.map(([value, label]) => ({
    value, label, countryCode: GENMAX_COUNTRIES[value] || 'us',
  }));

  const clearGeneratedAudio = () => {
    if (!project.scenes.some((scene) => scene.audioPath)) return;
    setScenes(project.scenes.map((scene) => ({ ...scene, audioPath: undefined, audioDuration: undefined })));
  };

  const changeEngine = (next: VoiceEngine) => {
    if (next === engine) return;
    setVoiceEngine(next);
    clearGeneratedAudio();
  };

  const updateConfig = (patch: Partial<VoiceConfig>) => {
    const voiceConfigs = {
      ...project.settings.voiceConfigs,
      [engine]: { ...config, ...patch },
    };
    patchSettings({ voiceConfigs } as Partial<ProjectSettings>);
    clearGeneratedAudio();
  };

  const selectModel = (modelId: string) => {
    const patch: Partial<VoiceConfig> = { modelId };
    if (engine === 'elevenlabs' && modelId !== 'eleven_v3' && config.language === 'vietnamese') patch.language = 'english';
    updateConfig(patch);
  };

  const selectLibraryVoice = (voice: GenSuiteVoice) => {
    // Remember the picked voice's metadata so its name still resolves after the
    // library closes, even when it came from the explore tab (not in `voices`).
    selectedVoiceMetaCache.set(voice.voiceId, voice);
    if (engine === 'edgetts') {
      updateConfig({ voiceId: voice.voiceId, language: voice.labels?.language || config.language });
    } else {
      updateConfig({ voiceId: voice.voiceId });
    }
    setVoiceLibraryOpen(false);
  };

  const stopVoicePreview = () => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    previewAudioRef.current = null;
    setPreviewingVoiceId(null);
    setPreviewLoadingVoiceId(null);
  };

  const toggleVoicePreview = async (voice: GenSuiteVoice) => {
    const canPreviewDynamically = engine === 'genvoice';
    if (!voice.previewUrl && !canPreviewDynamically) return;
    if (previewingVoiceId === voice.voiceId) {
      stopVoicePreview();
      return;
    }
    stopVoicePreview();
    setPreviewErrorVoiceId(null);
    setPreviewLoadingVoiceId(voice.voiceId);
    let previewUrl = voice.previewUrl || dynamicPreviewUrlsRef.current.get(voice.voiceId) || '';
    if (!previewUrl && canPreviewDynamically) {
      try {
        const blob = await getGenSuiteVoicePreview(keys.gensuiteApiKey, {
          engine: 'genvoice', voiceId: voice.voiceId, modelId: config.modelId,
        });
        previewUrl = URL.createObjectURL(blob);
        dynamicPreviewUrlsRef.current.set(voice.voiceId, previewUrl);
      } catch {
        setPreviewErrorVoiceId(voice.voiceId);
        setPreviewLoadingVoiceId(null);
        return;
      }
    }
    const audio = new Audio(previewUrl);
    previewAudioRef.current = audio;
    audio.addEventListener('playing', () => {
      setPreviewLoadingVoiceId(null);
      setPreviewingVoiceId(voice.voiceId);
    }, { once: true });
    audio.addEventListener('ended', stopVoicePreview, { once: true });
    audio.addEventListener('error', () => {
      setPreviewErrorVoiceId(voice.voiceId);
      stopVoicePreview();
    }, { once: true });
    void audio.play().catch(() => {
      setPreviewErrorVoiceId(voice.voiceId);
      stopVoicePreview();
    });
  };

  useEffect(() => () => {
    const audio = previewAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    for (const url of dynamicPreviewUrlsRef.current.values()) URL.revokeObjectURL(url);
    dynamicPreviewUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    stopVoicePreview();
    setPreviewErrorVoiceId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, voiceLibraryOpen]);

  const createVoiceClone = async () => {
    if ((engine !== 'genvoice' && engine !== 'minimax') || !cloneFile || !cloneName.trim()) return;
    setCloneBusy(true);
    setCloneError('');
    setCloneMessage('');
    try {
      const durationSeconds = await audioDuration(cloneFile);
      if (cloneFile.size > 20 * 1024 * 1024) throw new Error('Mẫu âm thanh không được vượt quá 20MB.');
      if (engine === 'genvoice' && durationSeconds && (durationSeconds < 5 || durationSeconds > 60)) {
        throw new Error('Mẫu GenVoice phải dài từ 5 đến 60 giây.');
      }
      if (!cloneLanguage) throw new Error('Hãy chọn ngôn ngữ cho voice clone.');
      if (!cloneRights) throw new Error('Bạn phải xác nhận quyền sử dụng mẫu giọng.');
      if (engine === 'minimax' && durationSeconds && (durationSeconds < 10 || durationSeconds > 5 * 60)) {
        throw new Error('Mẫu MiniMax phải dài từ 10 giây đến 5 phút.');
      }
      const minimaxLanguage = GENMAX_LANGUAGES.find(([id]) => id === cloneLanguage)?.[1];
      const result = await cloneGenSuiteVoice(keys.gensuiteApiKey, {
        engine,
        name: cloneName,
        file: cloneFile,
        language: engine === 'genvoice' ? cloneLanguage : minimaxLanguage,
        gender: engine === 'minimax' ? cloneGender : undefined,
        durationSeconds: durationSeconds || undefined,
      });
      setCloneMessage(`Đã gửi “${result.name}”. Giọng đang được xử lý; hãy bấm Đồng bộ giọng sau khi hoàn tất.`);
      delete voiceCatalogCache[engine];
      setCatalogRefresh((value) => value + 1);
    } catch (error) {
      const service = missingKeyService(error);
      if (service) flagMissingKey(service);
      setCloneError(errorMessage(error));
    } finally {
      setCloneBusy(false);
    }
  };

  const refreshVoiceCatalog = () => {
    if (catalogBusy) return;
    if (engine === 'edgetts') {
      edgeVoiceCache = null;
    } else {
      delete voiceCatalogCache[engine];
      modelCatalogCache = null;
      setCatalogModels((current) => ({ ...current, [engine]: [] }));
    }
    setVoices([]);
    setCatalogError('');
    setCatalogBusy(true);
    setCatalogRefresh((value) => value + 1);
  };

  const loadMoreExplore = async () => {
    if (!exploreNextPage || exploreBusy) return;
    setExploreBusy(true);
    setExploreError('');
    try {
      const result = await listGenSuiteVoicePage(keys.gensuiteApiKey, 'elevenlabs', {
        type: 'explore', page: exploreNextPage, pageSize: 30, search: voiceQuery,
        language: exploreLanguage, accent: exploreAccent, category: exploreQuality,
        gender: exploreGender, useCase: exploreUseCase,
      });
      setExploreVoices((current) => [...current, ...result.voices].filter((voice, index, list) => list.findIndex((item) => item.voiceId === voice.voiceId) === index));
      setExploreHasMore(result.hasMore);
      setExploreNextPage(result.nextPage);
    } catch (error) {
      setExploreError(errorMessage(error));
    } finally {
      setExploreBusy(false);
    }
  };

  useEffect(() => {
    const sentinel = exploreLoadMoreRef.current;
    const scrollRoot = voiceLibraryScrollRef.current;
    if (!voiceLibraryOpen || engine !== 'elevenlabs' || librarySource !== 'explore' || !sentinel || !scrollRoot) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && exploreHasMore && exploreNextPage && !exploreBusy) {
        void loadMoreExplore();
      }
    }, { root: scrollRoot, rootMargin: '220px 0px', threshold: 0.01 });

    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceLibraryOpen, engine, librarySource, exploreHasMore, exploreNextPage, exploreBusy, voiceQuery, exploreLanguage, exploreAccent, exploreQuality, exploreGender, exploreUseCase]);

  const selectedEngineOption = ENGINE_OPTIONS.find((option) => option.id === engine)!;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="px-6 pt-3">
        <div className="flex items-center gap-2 border-b border-white/10 py-3 text-sm font-bold text-white"><SlidersHorizontal size={15} /> Cấu hình giọng đọc</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5">
        <div className="space-y-6">
          <div>
            <label className="mb-3 block text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Nhà cung cấp</label>
            <button type="button" onClick={() => setProviderPickerOpen(true)} className="group flex w-full items-center gap-3.5 rounded-xl border border-white/[0.07] bg-white/[0.018] px-3.5 py-3 text-left transition-all duration-150 hover:border-white/[0.16] hover:bg-white/[0.035]"><span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xs font-black text-white/45"><span>{selectedEngineOption.mark}</span><img src={selectedEngineOption.thumbnail} alt="" className="absolute inset-0 h-full w-full object-contain" onError={(event) => { event.currentTarget.style.display = 'none'; }} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-white/90">{selectedEngineOption.label}</span><span className="mt-0.5 block truncate text-[11px] leading-4 text-white/40">{selectedEngineOption.description}</span></span><span className={`shrink-0 rounded px-1 py-px text-[8px] font-semibold uppercase ${selectedEngineOption.paid ? 'bg-amber-400/15 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{selectedEngineOption.paid ? 'Cloud API' : 'Miễn phí'}</span><ChevronDown size={14} className="shrink-0 -rotate-90 text-white/20 transition group-hover:text-white/45" /></button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between"><label className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Giọng nói</label><button type="button" onClick={refreshVoiceCatalog} disabled={catalogBusy} className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-emerald-300 transition hover:text-emerald-200 disabled:cursor-wait disabled:opacity-60"><RefreshCw size={11} className={catalogBusy ? 'animate-spin' : ''} /> {catalogBusy ? 'Đang đồng bộ…' : 'Đồng bộ giọng'}</button></div>
            <button onClick={() => { setVoiceQuery(''); setLibrarySource('system'); setVoiceLibraryOpen(true); }} disabled={catalogBusy} className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-left transition hover:border-white/20 disabled:opacity-70"><span className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">{catalogBusy ? <Loader2 size={18} className="animate-spin" /> : <User size={18} />}</span><span className="min-w-0"><span className="block truncate text-xs font-bold text-white">{selectedVoice?.name || (catalogBusy ? 'Đang tải giọng…' : 'Chưa chọn giọng')}</span><span className="mt-1 block truncate text-[9px] font-black uppercase tracking-widest text-white/25">{selectedVoice?.category || selectedVoice?.labels?.gender || 'GenSuite Voice'}</span></span></span><ChevronDown size={15} className="shrink-0 text-white/25" /></button>
            {(engine === 'genvoice' || engine === 'minimax') && <button type="button" onClick={() => { setCloneOpen(true); setCloneMessage(''); setCloneError(''); setCloneLanguage(''); setCloneRights(false); }} className="group relative flex w-full items-center justify-between overflow-hidden rounded-2xl bg-[linear-gradient(135deg,rgba(5,16,13,.95),rgba(10,65,48,.88))] px-4 py-3.5"><span className="pointer-events-none absolute -left-1/2 top-0 h-full w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent blur-md transition-transform duration-700 group-hover:translate-x-[340%]" /><span className="relative flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/20 bg-white/10"><Copy size={15} /></span><span className="text-[10px] font-black uppercase tracking-[0.16em]">Sao chép giọng nói</span></span><ChevronDown size={14} className="relative -rotate-90 text-white/50" /></button>}
          </div>

          {engine !== 'edgetts' && <div className="space-y-2"><label className="block text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Mô hình</label><button type="button" disabled={catalogBusy || !models.length} onClick={() => setModelPickerOpen(true)} className="flex w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-xs font-semibold text-white/80 transition hover:border-white/20 disabled:opacity-50"><span className="min-w-0 flex-1 truncate text-left">{models.find((model) => model.id === config.modelId)?.name || 'Đang tải mô hình…'}</span>{models.find((model) => model.id === config.modelId)?.paidOnly && <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[8px] font-bold uppercase text-emerald-300">Mới nhất</span>}<ChevronDown size={14} className="-rotate-90 text-white/30" /></button></div>}
          {catalogError && <p className="rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-[10px] leading-4 text-red-300">{catalogError}</p>}
          {engine === 'edgetts' && <p className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-[10px] leading-4 text-white/35">Edge TTS dùng dịch vụ giọng neural của Microsoft — miễn phí, không cần API key, nhưng cần kết nối mạng. Ngôn ngữ được xác định theo giọng bạn chọn (có tiếng Việt).</p>}
          {engine === 'genvoice' && config.modelId === 'genvoice-tts-2' && <div className="space-y-2"><label className="block text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Ngôn ngữ bắt buộc</label><LanguageDropdown value={config.language} options={genvoiceLanguageOptions} onChange={(language) => updateConfig({ language })} /></div>}
          {(engine === 'elevenlabs' || engine === 'minimax') && <div className="space-y-2"><label className="block text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Ngôn ngữ bắt buộc</label><LanguageDropdown value={genmaxLanguageOptions.some((item) => item.value === config.language) ? config.language : ''} options={genmaxLanguageOptions} onChange={(language) => updateConfig({ language })} />{engine === 'elevenlabs' && config.modelId !== 'eleven_v3' && <span className="block text-[10px] text-white/25">Tiếng Việt chỉ khả dụng với Eleven v3.</span>}</div>}
          {engine !== 'elevenlabs' || config.modelId !== 'eleven_v3' ? <RangeField label="Tốc độ" value={config.speed} min={engine === 'genvoice' || engine === 'edgetts' ? 0.5 : engine === 'elevenlabs' ? 0.7 : 0.5} max={engine === 'genvoice' || engine === 'edgetts' ? 1.5 : engine === 'elevenlabs' ? 1.2 : 2} step={engine === 'elevenlabs' ? 0.01 : 0.05} hint="1.0 là tốc độ tự nhiên" onChange={(speed) => updateConfig({ speed })} /> : null}
          {engine === 'genvoice' && config.modelId === 'genvoice-tts-2' && <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-[0.18em] text-white/40">Chế độ thể hiện</label><div className="grid grid-cols-3 gap-1.5">{(['STABLE', 'BALANCED', 'CREATIVE'] as const).map((mode) => <button key={mode} onClick={() => updateConfig({ deliveryMode: mode })} className={`rounded-lg border px-2 py-2 text-[9px] font-bold uppercase ${config.deliveryMode === mode ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/[0.02] text-white/40 hover:text-white/70'}`}>{mode === 'STABLE' ? 'Ổn định' : mode === 'BALANCED' ? 'Cân bằng' : 'Sáng tạo'}</button>)}</div></div>}
          {engine === 'genvoice' && config.modelId !== 'genvoice-tts-2' && <RangeField label="Nhiệt độ" value={config.temperature} min={0} max={2} step={0.05} hint="Cao hơn sẽ biểu cảm và biến thiên hơn" onChange={(temperature) => updateConfig({ temperature })} />}
          {engine === 'elevenlabs' && <><RangeField label="Ổn định" value={config.stability} min={0} max={1} step={0.01} onChange={(stability) => updateConfig({ stability })} />{config.modelId !== 'eleven_v3' && <><RangeField label="Tương đồng" value={config.similarityBoost} min={0} max={1} step={0.01} onChange={(similarityBoost) => updateConfig({ similarityBoost })} /><RangeField label="Cường điệu phong cách" value={config.style} min={0} max={1} step={0.01} onChange={(style) => updateConfig({ style })} /><div className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.02] px-3.5 py-3"><span className="text-[9px] font-black uppercase tracking-widest text-white/40">Tăng cường người nói</span><button onClick={() => updateConfig({ useSpeakerBoost: !config.useSpeakerBoost })} className={`relative h-6 w-11 rounded-full ${config.useSpeakerBoost ? 'bg-teal-500' : 'bg-white/10'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${config.useSpeakerBoost ? 'left-6' : 'left-1'}`} /></button></div></>}</>}
          {engine === 'minimax' && <><RangeField label="Cao độ" value={config.pitch} min={-12} max={12} step={1} onChange={(pitch) => updateConfig({ pitch })} /><RangeField label="Âm lượng" value={config.volume} min={0.1} max={10} step={0.1} onChange={(volume) => updateConfig({ volume })} /></>}
          {footer}
        </div>
      </div>

      {providerPickerOpen && <div className="absolute inset-0 z-40 flex flex-col bg-[#0f0f10] voice-sheet-in">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4"><button type="button" onClick={() => setProviderPickerOpen(false)} className="rounded-lg p-2 text-white/45 transition hover:bg-white/5 hover:text-white"><ArrowLeft size={17} /></button><div><h3 className="text-sm font-bold">Chọn nhà cung cấp</h3><p className="mt-0.5 text-[9px] uppercase tracking-wider text-white/30">Engine tạo giọng cho dự án</p></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="flex flex-col gap-2">{ENGINE_OPTIONS.map((option) => { const active = option.id === engine; return <button key={option.id} type="button" onClick={() => { changeEngine(option.id); setProviderPickerOpen(false); }} className={`group relative flex items-center gap-3.5 overflow-hidden rounded-xl border px-3.5 py-3 text-left transition-all duration-150 ${active ? 'border-emerald-400/40 bg-emerald-400/[0.06]' : 'border-white/[0.07] bg-white/[0.018] hover:border-white/[0.16] hover:bg-white/[0.035]'}`}><span className={`relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xs font-black transition ${active ? 'text-emerald-200' : 'text-white/45 group-hover:text-white/70'}`}><span>{option.mark}</span><img src={option.thumbnail} alt="" className="absolute inset-0 h-full w-full object-contain" onError={(event) => { event.currentTarget.style.display = 'none'; }} /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className={`truncate text-sm font-bold transition ${active ? 'text-white' : 'text-white/90'}`}>{option.label}</span>{active && <Check size={14} className="shrink-0 text-emerald-300" strokeWidth={3} />}</span><span className="mt-0.5 block truncate text-[11px] leading-4 text-white/40">{option.description}</span></span><span className={`shrink-0 rounded px-1 py-px text-[8px] font-semibold uppercase ${option.paid ? 'bg-amber-400/15 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>{option.paid ? 'Cloud API' : 'Miễn phí'}</span><ChevronDown size={14} className={`shrink-0 -rotate-90 transition ${active ? 'text-emerald-300/70' : 'text-white/20 group-hover:text-white/45'}`} /></button>; })}</div></div>
        <div className="border-t border-white/10 px-5 py-4 text-[10px] leading-4 text-white/25">Nhà cung cấp Cloud API sử dụng GenSuite API key và credits trong tài khoản của bạn.</div>
      </div>}
      {modelPickerOpen && <ModelPickerSheet models={models} selectedId={config.modelId} onSelect={selectModel} onClose={() => setModelPickerOpen(false)} />}
      {cloneOpen && (engine === 'genvoice' || engine === 'minimax') && <div className="absolute inset-0 z-40 flex flex-col bg-[#0f0f10] voice-sheet-in">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4"><button type="button" onClick={() => setCloneOpen(false)} className="rounded-lg p-2 text-white/45 hover:bg-white/5 hover:text-white"><ArrowLeft size={17} /></button><div><h3 className="text-sm font-bold">Sao chép giọng {engine === 'genvoice' ? 'GenVoice' : 'MiniMax'}</h3><p className="mt-0.5 text-[9px] uppercase tracking-wider text-white/30">Tạo voice clone qua GenSuite API</p></div></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <label className="block space-y-2 text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Tên giọng<input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="Ví dụ: Giọng kể chuyện của tôi" className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-xs font-medium normal-case tracking-normal text-white outline-none focus:border-emerald-400/60" /></label>
          <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Ngôn ngữ <span className="text-emerald-300">*</span></label><LanguageDropdown value={cloneLanguage} options={engine === 'genvoice' ? genvoiceLanguageOptions : allGenmaxLanguageOptions} onChange={setCloneLanguage} /></div>
          <label className="block space-y-2 text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Mẫu âm thanh <span className="text-emerald-300">*</span><span className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 text-center transition hover:border-emerald-400/40"><Upload size={20} className="text-emerald-300" /><span className="max-w-full truncate text-xs font-semibold normal-case tracking-normal text-white/65">{cloneFile?.name || 'Chọn WAV, MP3 hoặc WEBM'}</span><span className="text-[9px] font-normal normal-case tracking-normal text-white/25">Tối đa 20MB · {engine === 'genvoice' ? 'dài 5–60 giây' : 'dài 10 giây–5 phút'}</span></span><input type="file" accept="audio/wav,audio/mpeg,audio/webm,.wav,.mp3,.webm" className="hidden" onChange={(event) => setCloneFile(event.target.files?.[0] || null)} /></label>
          {engine === 'minimax' && <div className="space-y-2"><label className="text-[10px] font-black uppercase tracking-[0.16em] text-white/40">Giới tính</label><div className="grid grid-cols-2 gap-2">{[['female', 'Nữ'], ['male', 'Nam']].map(([value, label]) => <button key={value} type="button" onClick={() => setCloneGender(value)} className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${cloneGender === value ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200' : 'border-white/10 text-white/40'}`}>{label}</button>)}</div></div>}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3.5 text-[10px] leading-4 text-white/55"><input type="checkbox" checked={cloneRights} onChange={(event) => setCloneRights(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-400" /><span>Tôi xác nhận mình sở hữu hoặc đã được cho phép sử dụng mẫu giọng này để tạo voice clone. <span className="text-emerald-300">*</span></span></label>
          <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3 text-[10px] leading-4 text-amber-100/60">Tạo voice clone sử dụng 1.000 credits và chiếm một vị trí clone trong gói của bạn.</div>
          {cloneError && <p className="rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{cloneError}</p>}{cloneMessage && <p className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs leading-5 text-emerald-300">{cloneMessage}</p>}
          <button type="button" onClick={createVoiceClone} disabled={cloneBusy || !cloneName.trim() || !cloneFile || !cloneLanguage || !cloneRights || Boolean(cloneMessage)} className="primary-action flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold disabled:opacity-40">{cloneBusy ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}{cloneBusy ? 'Đang gửi mẫu…' : 'Tạo voice clone'}</button>
        </div>
      </div>}

      {voiceLibraryOpen && <div className="fixed inset-0 z-[80] flex items-center justify-center p-5 voice-pop-in">
        <button type="button" aria-label="Đóng thư viện" onClick={() => setVoiceLibraryOpen(false)} className="absolute inset-0 bg-black/80 backdrop-blur-xl" />
        <div className="relative flex h-[88vh] max-h-[850px] w-full max-w-6xl flex-col overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#060606] shadow-[0_60px_200px_rgba(0,0,0,.8)]">
          <header className="shrink-0 bg-black/40 p-6">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold">Thư viện giọng nói</h2>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/30">{engine === 'elevenlabs' ? 'ElevenLabs' : engine === 'genvoice' ? 'GenVoice' : engine === 'minimax' ? 'MiniMax' : 'Edge TTS'}</p>
              </div>
              <label className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-4 transition focus-within:border-teal-400/35 focus-within:bg-white/[0.035]"><Search size={16} className="text-white/25" /><input autoFocus value={voiceQuery} onChange={(event) => setVoiceQuery(event.target.value)} placeholder={engine === 'elevenlabs' && librarySource === 'explore' ? 'Tìm trong thư viện cộng đồng…' : 'Tìm tên giọng…'} className="voice-search-input w-full bg-transparent py-3.5 text-sm text-white outline-none placeholder:text-white/25" /></label>
              <button type="button" onClick={() => setVoiceLibraryOpen(false)} className="rounded-full bg-white/5 p-3 text-white/40 transition hover:bg-red-500/20 hover:text-red-300"><X size={20} /></button>
            </div>
            {engine === 'elevenlabs' && <div className="mt-5 inline-flex rounded-xl border border-white/[0.08] bg-white/[0.02] p-1"><button type="button" onClick={() => { setLibrarySource('system'); setVoiceQuery(''); }} className={`rounded-lg px-5 py-2 text-[10px] font-black uppercase tracking-widest ${librarySource === 'system' ? 'bg-white/[0.09] text-white shadow-sm' : 'text-white/30 hover:text-white/60'}`}>Giọng hệ thống</button><button type="button" onClick={() => { setLibrarySource('explore'); setVoiceQuery(''); }} className={`rounded-lg px-5 py-2 text-[10px] font-black uppercase tracking-widest ${librarySource === 'explore' ? 'bg-white/[0.09] text-white shadow-sm' : 'text-white/30 hover:text-white/60'}`}>Khám phá</button></div>}
          </header>
          {engine === 'elevenlabs' && librarySource === 'explore' && <div className="shrink-0 border-y border-white/[0.055] bg-white/[0.012] px-6 py-4"><div className="grid grid-cols-2 gap-3 md:grid-cols-5"><CompactFilter label="Ngôn ngữ" value={exploreLanguage} options={EXPLORE_LANGUAGES} onChange={setExploreLanguage} /><CompactFilter label="Giọng điệu" value={exploreAccent} options={EXPLORE_ACCENTS} onChange={setExploreAccent} /><CompactFilter label="Chất lượng" value={exploreQuality} options={EXPLORE_QUALITIES} onChange={setExploreQuality} /><CompactFilter label="Giới tính" value={exploreGender} options={EXPLORE_GENDERS} onChange={setExploreGender} /><CompactFilter label="Phân loại" value={exploreUseCase} options={EXPLORE_USE_CASES} onChange={setExploreUseCase} /></div></div>}
          {engine === 'edgetts' && <div className="shrink-0 border-y border-white/[0.055] bg-white/[0.012] px-6 py-4"><div className="grid max-w-xs grid-cols-1"><CompactFilter label="Ngôn ngữ" value={edgeLanguage} options={edgeLanguageOptions} onChange={setEdgeLanguage} /></div></div>}
          <div ref={voiceLibraryScrollRef} className="relative min-h-0 flex-1 overflow-y-auto p-6">
            {exploreError && librarySource === 'explore' && <p className="mb-4 rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-xs text-red-300">{exploreError}</p>}
            {exploreBusy && librarySource === 'explore' && visibleLibraryVoices.length > 0 && <div className="pointer-events-none sticky top-0 z-20 -mb-10 flex justify-center"><div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/80 px-5 py-3 shadow-[0_12px_38px_rgba(0,0,0,.5)] backdrop-blur-xl"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-teal-300 [animation-delay:-.24s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/30 [animation-delay:-.12s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/20" /></span><span className="text-[9px] font-bold uppercase tracking-[0.28em] text-white/55">Đang đồng bộ giọng</span></div></div>}
            {exploreBusy && librarySource === 'explore' && !visibleLibraryVoices.length ? <div className="flex h-full items-center justify-center gap-3 text-xs uppercase tracking-widest text-white/40"><Loader2 size={18} className="animate-spin text-teal-300" /> Đang tải giọng khám phá…</div> : visibleLibraryVoices.length ? <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{visibleLibraryVoices.map((voice) => { const isPreviewing = previewingVoiceId === voice.voiceId; const isPreviewLoading = previewLoadingVoiceId === voice.voiceId; const previewFailed = previewErrorVoiceId === voice.voiceId; const canPreview = Boolean(voice.previewUrl) || engine === 'genvoice'; return <div key={voice.voiceId} className={`group flex min-w-0 items-center gap-3 rounded-2xl border p-3 text-left transition duration-200 ${voice.voiceId === config.voiceId ? 'border-teal-400/35 bg-teal-400/[0.075] shadow-[0_0_0_1px_rgba(45,212,191,.04)]' : 'border-white/[0.065] bg-white/[0.018] hover:border-white/[0.14] hover:bg-white/[0.035]'}`}><button type="button" title={previewFailed ? 'Không phát được bản nghe thử' : canPreview ? (isPreviewing ? 'Dừng nghe thử' : 'Nghe thử giọng') : 'Giọng này chưa có bản nghe thử'} disabled={!canPreview || isPreviewLoading} onClick={() => void toggleVoicePreview(voice)} className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition ${canPreview ? 'bg-white/[0.055] text-white/45 hover:bg-emerald-400/15 hover:text-emerald-300' : 'cursor-not-allowed bg-white/[0.025] text-white/10'} ${previewFailed ? 'text-red-300/60' : ''}`}>{isPreviewLoading ? <Loader2 size={17} className="animate-spin text-emerald-300" /> : isPreviewing ? <Pause size={17} className="text-emerald-300" /> : <Play size={17} />}</button><button type="button" onClick={() => selectLibraryVoice(voice)} className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-white/85">{voice.name}</span><span className="mt-1 block truncate text-[9px] font-black uppercase tracking-wider text-white/22">{previewFailed ? 'Không phát được bản nghe thử' : voice.category || voice.labels?.use_case || voice.labels?.gender || 'Voice'}</span></span>{voice.voiceId === config.voiceId && <Check size={16} className="shrink-0 text-teal-300" />}</button></div>; })}</div> : <div className="flex h-full flex-col items-center justify-center text-center text-white/30"><Search size={42} className="mb-4 opacity-20" /><p className="text-sm">Không tìm thấy giọng phù hợp.</p></div>}
            {engine === 'elevenlabs' && librarySource === 'explore' && visibleLibraryVoices.length > 0 && <div ref={exploreLoadMoreRef} className="flex h-16 items-end justify-center pb-1 text-xs text-white/30">{exploreBusy ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin text-teal-300" /> Đang đồng bộ thêm giọng…</span> : exploreHasMore ? 'Cuộn xuống để xem thêm' : 'Đã tải hết kết quả'}</div>}
          </div>
        </div>
      </div>}
    </div>
  );
}
