import type { VoiceEngine } from '../../shared/types';
import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';

const BASE_URL = 'https://api.gensuite.site/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export type GenSuiteVoiceEngine = Exclude<VoiceEngine, 'edgetts'>;

export interface GenSuiteModel {
  id: string;
  name: string;
  paidOnly: boolean;
  requiresLanguage: boolean;
}

export interface GenSuiteVoice {
  voiceId: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
}

export interface GenSuiteVoicePage {
  voices: GenSuiteVoice[];
  hasMore: boolean;
  nextPage: number | null;
}

export interface GenSuiteCloneRequest {
  engine: 'genvoice' | 'minimax';
  name: string;
  file: File;
  language?: string;
  gender?: string;
  durationSeconds?: number;
}

function authorization(apiKey: string): Record<string, string> {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('MISSING_KEY:gensuite');
  return { Authorization: `Bearer ${key}` };
}

async function readJson(response: Response): Promise<any> {
  const data = await response.json().catch(() => null);
  if (response.status === 401 || data?.error === 'INVALID_API_KEY' || data?.error === 'UNAUTHORIZED') throw new Error('MISSING_KEY:gensuite');
  if (!response.ok) {
    const message = String(data?.message || data?.error || `GenSuite API lỗi ${response.status}`);
    throw new Error(message);
  }
  return data;
}

export async function listGenSuiteModels(apiKey: string): Promise<Record<GenSuiteVoiceEngine, GenSuiteModel[]>> {
  const response = await fetch(`${BASE_URL}/models`, { headers: authorization(apiKey) });
  const data = await readJson(response);
  const result: Record<GenSuiteVoiceEngine, GenSuiteModel[]> = { genvoice: [], elevenlabs: [], minimax: [] };
  for (const group of Array.isArray(data?.engines) ? data.engines : []) {
    const engine = String(group?.engine || '') as GenSuiteVoiceEngine;
    if (!(engine in result)) continue;
    result[engine] = (Array.isArray(group?.models) ? group.models : []).map((model: any) => ({
      id: String(model?.id || ''),
      name: String(model?.name || model?.id || ''),
      paidOnly: Boolean(model?.paidOnly),
      requiresLanguage: Boolean(model?.requiresLanguage),
    })).filter((model: GenSuiteModel) => model.id);
  }
  return result;
}

export async function listGenSuiteVoicePage(apiKey: string, engine: GenSuiteVoiceEngine, options: {
  type?: 'all' | 'system' | 'clone' | 'explore';
  page?: number;
  pageSize?: number;
  search?: string;
  gender?: string;
  language?: string;
  accent?: string;
  category?: string;
  useCase?: string;
} = {}): Promise<GenSuiteVoicePage> {
  const query = new URLSearchParams({
    engine,
    type: options.type || 'all',
    page: String(options.page || 1),
    pageSize: String(options.pageSize || 50),
  });
  if (options.search?.trim()) query.set('search', options.search.trim());
  if (options.gender) query.set('gender', options.gender);
  if (options.language) query.set('language', options.language);
  if (options.accent) query.set('accent', options.accent);
  if (options.category) query.set('category', options.category);
  if (options.useCase) query.set('useCase', options.useCase);
  const response = await fetch(`${BASE_URL}/voices?${query}`, { headers: authorization(apiKey) });
  const data = await readJson(response);
  const voices = (Array.isArray(data?.voices) ? data.voices : []).map((voice: any) => ({
    voiceId: String(voice?.voiceId || ''),
    name: String(voice?.name || voice?.voiceId || ''),
    category: voice?.category ? String(voice.category) : undefined,
    labels: voice?.labels && typeof voice.labels === 'object' ? voice.labels : undefined,
    previewUrl: String(voice?.previewUrl || voice?.preview_url || '').trim() || undefined,
  })).filter((voice: GenSuiteVoice) => voice.voiceId);
  return {
    voices,
    hasMore: Boolean(data?.hasMore),
    nextPage: data?.nextPage ? Number(data.nextPage) : null,
  };
}

async function listVoiceType(apiKey: string, engine: GenSuiteVoiceEngine, type: 'all' | 'system' | 'clone'): Promise<GenSuiteVoice[]> {
  const voices: GenSuiteVoice[] = [];
  let page = 1;
  for (;;) {
    const result = await listGenSuiteVoicePage(apiKey, engine, { type, page, pageSize: 100 });
    for (const voice of result.voices) {
      if (voices.some((item) => item.voiceId === voice.voiceId)) continue;
      voices.push(voice);
    }
    if (!result.hasMore || !result.nextPage || page >= 20) break;
    page = result.nextPage;
  }
  return voices;
}

export async function listGenSuiteVoices(apiKey: string, engine: GenSuiteVoiceEngine): Promise<GenSuiteVoice[]> {
  // Product rule: MiniMax exposes only voices cloned by the current user.
  // System voices must never appear in the desktop voice library.
  if (engine === 'minimax') return listVoiceType(apiKey, engine, 'clone');
  return listVoiceType(apiKey, engine, 'all');
}

export async function cloneGenSuiteVoice(apiKey: string, request: GenSuiteCloneRequest): Promise<{ voiceId: string; status: string; name: string }> {
  const form = new FormData();
  form.set('engine', request.engine);
  form.set('name', request.name.trim());
  form.set('file', request.file, request.file.name);
  if (request.language) form.set('language', request.language);
  if (request.gender && request.engine === 'minimax') form.set('gender', request.gender);
  if (Number.isFinite(request.durationSeconds)) form.set('durationSeconds', String(request.durationSeconds));
  const response = await fetch(`${BASE_URL}/voices/clone`, {
    method: 'POST', headers: authorization(apiKey), body: form,
  });
  const data = await readJson(response);
  return {
    voiceId: String(data?.voiceId || ''),
    status: String(data?.status || 'processing'),
    name: String(data?.name || request.name),
  };
}

export async function getGenSuiteVoicePreview(apiKey: string, request: {
  engine: GenSuiteVoiceEngine;
  voiceId: string;
  modelId?: string;
}): Promise<Blob> {
  const response = await fetch(`${BASE_URL}/voices/preview`, {
    method: 'POST',
    headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(String(data?.message || data?.error || `Không thể nghe thử (${response.status})`));
  }
  return response.blob();
}

function requestSettings(engine: GenSuiteVoiceEngine, req: VoiceRequest): Record<string, unknown> {
  if (engine === 'genvoice') {
    return req.modelId === 'genvoice-tts-2'
      ? { speed: req.speed, delivery_mode: req.deliveryMode }
      : { speed: req.speed, temperature: req.temperature };
  }
  if (engine === 'elevenlabs') {
    const language = GENMAX_LANGUAGES.find((item) => item.id === req.language);
    const languageSettings = { genmax_language: req.language, language_code: language?.elevenCode };
    if (req.modelId === 'eleven_v3') return { stability: req.stability, ...languageSettings };
    return {
      ...languageSettings,
      speed: req.speed,
      stability: req.stability,
      similarity_boost: req.similarityBoost,
      style: req.style,
      use_speaker_boost: req.useSpeakerBoost,
    };
  }
  const language = GENMAX_LANGUAGES.find((item) => item.id === req.language);
  return { speed: req.speed, pitch: req.pitch, vol: req.volume, genmax_language: req.language, language_code: language?.minimaxName };
}

const GENMAX_LANGUAGES = [
  { id: 'english', elevenCode: 'en', minimaxName: 'English' },
  { id: 'vietnamese', elevenCode: 'vi', minimaxName: 'Vietnamese' },
  { id: 'chinese', elevenCode: 'zh', minimaxName: 'Chinese (Mandarin)' },
  { id: 'cantonese', elevenCode: 'yue', minimaxName: 'Cantonese' },
  { id: 'japanese', elevenCode: 'ja', minimaxName: 'Japanese' },
  { id: 'korean', elevenCode: 'ko', minimaxName: 'Korean' },
  { id: 'thai', elevenCode: 'th', minimaxName: 'Thai' },
  { id: 'indonesian', elevenCode: 'id', minimaxName: 'Indonesian' },
  { id: 'malay', elevenCode: 'ms', minimaxName: 'Malay' },
  { id: 'filipino', elevenCode: 'fil', minimaxName: 'Filipino' },
  { id: 'hindi', elevenCode: 'hi', minimaxName: 'Hindi' },
  { id: 'tamil', elevenCode: 'ta', minimaxName: 'Tamil' },
  { id: 'arabic', elevenCode: 'ar', minimaxName: 'Arabic' },
  { id: 'persian', elevenCode: 'fa', minimaxName: 'Persian' },
  { id: 'hebrew', elevenCode: 'he', minimaxName: 'Hebrew' },
  { id: 'turkish', elevenCode: 'tr', minimaxName: 'Turkish' },
  { id: 'french', elevenCode: 'fr', minimaxName: 'French' },
  { id: 'german', elevenCode: 'de', minimaxName: 'German' },
  { id: 'spanish', elevenCode: 'es', minimaxName: 'Spanish' },
  { id: 'catalan', elevenCode: 'ca', minimaxName: 'Catalan' },
  { id: 'portuguese', elevenCode: 'pt', minimaxName: 'Portuguese' },
  { id: 'italian', elevenCode: 'it', minimaxName: 'Italian' },
  { id: 'dutch', elevenCode: 'nl', minimaxName: 'Dutch' },
  { id: 'russian', elevenCode: 'ru', minimaxName: 'Russian' },
  { id: 'ukrainian', elevenCode: 'uk', minimaxName: 'Ukrainian' },
  { id: 'polish', elevenCode: 'pl', minimaxName: 'Polish' },
  { id: 'czech', elevenCode: 'cs', minimaxName: 'Czech' },
  { id: 'slovak', elevenCode: 'sk', minimaxName: 'Slovak' },
  { id: 'hungarian', elevenCode: 'hu', minimaxName: 'Hungarian' },
  { id: 'romanian', elevenCode: 'ro', minimaxName: 'Romanian' },
  { id: 'bulgarian', elevenCode: 'bg', minimaxName: 'Bulgarian' },
  { id: 'greek', elevenCode: 'el', minimaxName: 'Greek' },
  { id: 'croatian', elevenCode: 'hr', minimaxName: 'Croatian' },
  { id: 'slovenian', elevenCode: 'sl', minimaxName: 'Slovenian' },
  { id: 'danish', elevenCode: 'da', minimaxName: 'Danish' },
  { id: 'swedish', elevenCode: 'sv', minimaxName: 'Swedish' },
  { id: 'norwegian', elevenCode: 'no', minimaxName: 'Norwegian' },
  { id: 'nynorsk', elevenCode: 'nn', minimaxName: 'Nynorsk' },
  { id: 'finnish', elevenCode: 'fi', minimaxName: 'Finnish' },
  { id: 'afrikaans', elevenCode: 'af', minimaxName: 'Afrikaans' },
] as const;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('gensuite:cancelled'));
    }, { once: true });
  });
}

export class GenSuiteVoiceAdapter implements IVoiceProvider {
  readonly isLocal = false;
  private controller: AbortController | null = null;
  private jobId: string | null = null;

  constructor(readonly engine: GenSuiteVoiceEngine, private apiKey: string) {}

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw new Error('Đoạn văn trống.');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const headers = { ...authorization(this.apiKey), 'Content-Type': 'application/json' };
    const body: Record<string, unknown> = {
      engine: this.engine,
      model: req.modelId,
      voiceId: req.voiceId,
      text: req.text,
      settings: requestSettings(this.engine, req),
    };
    if (this.engine === 'genvoice' && req.modelId === 'genvoice-tts-2') {
      body.language = req.language === 'auto' ? 'vi' : req.language;
    }

    const submitResponse = await fetch(`${BASE_URL}/tts`, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
    const submit = await readJson(submitResponse);
    this.jobId = String(submit?.jobId || '');
    if (!this.jobId) throw new Error('GenSuite API không trả về jobId.');

    const startedAt = Date.now();
    let job = submit;
    while (job?.status === 'pending' || job?.status === 'processing') {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) throw new Error('GenSuite TTS quá thời gian chờ (10 phút).');
      await delay(POLL_INTERVAL_MS, signal);
      const response = await fetch(`${BASE_URL}/tts/${encodeURIComponent(this.jobId)}`, {
        headers: authorization(this.apiKey), signal,
      });
      job = await readJson(response);
    }
    if (job?.status !== 'done' || !job?.audioUrl) {
      throw new Error(String(job?.message || job?.error || `Tạo giọng thất bại (${job?.status || 'unknown'}).`));
    }

    const audioPath = await window.gensuite.audio.download({
      projectId: req.projectId,
      segmentId: req.segmentId,
      url: String(job.audioUrl),
      format: String(job?.audioFormat || ''),
    });
    const apiDuration = Number(job?.audioDurationMs) / 1000;
    return { audioPath, durationSec: Number.isFinite(apiDuration) && apiDuration > 0 ? apiDuration : 0 };
  }

  cancel(): void {
    const jobId = this.jobId;
    this.controller?.abort();
    if (jobId) {
      fetch(`${BASE_URL}/tts/${encodeURIComponent(jobId)}`, {
        method: 'DELETE', headers: authorization(this.apiKey),
      }).catch(() => undefined);
    }
  }
}
