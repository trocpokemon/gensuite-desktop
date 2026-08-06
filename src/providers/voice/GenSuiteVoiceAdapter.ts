import type { VoiceEngine } from '../../shared/types';
import type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';
import { gensuiteFetch } from '../../lib/gensuiteAuth';
import type { GenSuiteFeature } from '../../lib/gensuiteAuth';
import { isPublicAppError, type AppErrorContext } from '../../shared/appErrors';
import { clientAppError } from '../clientAppError';
import {
  createVoiceCheckpoint,
  loadVoiceCheckpoint,
  retryDelay,
  saveVoiceCheckpoint,
  splitVoiceText,
  voiceRequestKey,
} from './voiceReliability';

const BASE_URL = 'https://api.gensuite.site/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 35_000;
const MAX_DESKTOP_VOICE_CHARS = 50_000;

export type GenSuiteVoiceEngine = Exclude<VoiceEngine, 'edgetts' | 'capcuttts'>;

export interface GenSuiteModel {
  id: string;
  name: string;
  paidOnly: boolean;
  requiresLanguage: boolean;
  creditRate?: number;
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

async function readJson(response: Response, context?: AppErrorContext): Promise<any> {
  const data = await response.json().catch(() => null);
  if (response.status === 401 || data?.error === 'INVALID_API_KEY' || data?.error === 'AUTH_REQUIRED') throw new Error('AUTH_REQUIRED:gensuite');
  if (data?.error === 'FEATURE_UPGRADE_REQUIRED') throw new Error('UPGRADE_REQUIRED:basic');
  if (response.status === 402 || data?.error === 'INSUFFICIENT_CREDITS') throw new Error('INSUFFICIENT_CREDITS');
  if (!response.ok) {
    if (response.status === 429) throw clientAppError('VOICE_RATE_LIMITED', context);
    if (response.status === 409) throw clientAppError('VOICE_JOB_CONFLICT', context);
    if (response.status === 408) throw clientAppError('VOICE_REQUEST_TIMEOUT', context);
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      if (data?.error === 'TEXT_TOO_LONG') throw clientAppError('VOICE_TEXT_TOO_LONG', context);
      throw clientAppError('VOICE_REQUEST_REJECTED', context);
    }
    if (response.status === 403) throw clientAppError('VOICE_SERVICE_ACCESS_DENIED', context);
    throw clientAppError(response.status >= 500 ? 'VOICE_SERVICE_UNAVAILABLE' : 'VOICE_RESPONSE_INVALID', context);
  }
  if (!data || typeof data !== 'object') throw clientAppError('VOICE_RESPONSE_INVALID', context);
  return data;
}

async function requestPublicJson(url: string, init: RequestInit = {}, context?: AppErrorContext): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await gensuiteFetch(url, { ...init, signal: controller.signal });
    return await readJson(response, context);
  } catch (error) {
    if (timedOut) throw clientAppError('VOICE_REQUEST_TIMEOUT', context);
    if (isPublicAppError(error)
      || String(error).includes('AUTH_REQUIRED:gensuite')
      || String(error).includes('UPGRADE_REQUIRED')
      || String(error).includes('INSUFFICIENT_CREDITS')) throw error;
    throw clientAppError('VOICE_SERVICE_UNAVAILABLE', context);
  } finally {
    clearTimeout(timer);
  }
}

export async function listGenSuiteModels(): Promise<Record<GenSuiteVoiceEngine, GenSuiteModel[]>> {
  const data = await requestPublicJson(`${BASE_URL}/models`);
  const result: Record<GenSuiteVoiceEngine, GenSuiteModel[]> = { genvoice: [], elevenlabs: [], minimax: [] };
  for (const group of Array.isArray(data?.engines) ? data.engines : []) {
    const engine = String(group?.engine || '') as GenSuiteVoiceEngine;
    if (!(engine in result)) continue;
    result[engine] = (Array.isArray(group?.models) ? group.models : []).map((model: any) => ({
      id: String(model?.id || ''),
      name: String(model?.name || model?.id || ''),
      paidOnly: Boolean(model?.paidOnly),
      requiresLanguage: Boolean(model?.requiresLanguage),
      creditRate: Number.isFinite(Number(model?.creditRate ?? model?.rate ?? model?.creditMultiplier))
        ? Number(model?.creditRate ?? model?.rate ?? model?.creditMultiplier)
        : undefined,
    })).filter((model: GenSuiteModel) => model.id);
  }
  return result;
}

export async function listGenSuiteVoicePage(engine: GenSuiteVoiceEngine, options: {
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
  const data = await requestPublicJson(`${BASE_URL}/voices?${query}`);
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

async function listVoiceType(engine: GenSuiteVoiceEngine, type: 'all' | 'system' | 'clone'): Promise<GenSuiteVoice[]> {
  const voices: GenSuiteVoice[] = [];
  let page = 1;
  for (;;) {
    const result = await listGenSuiteVoicePage(engine, { type, page, pageSize: 100 });
    for (const voice of result.voices) {
      if (voices.some((item) => item.voiceId === voice.voiceId)) continue;
      voices.push(voice);
    }
    if (!result.hasMore || !result.nextPage || page >= 20) break;
    page = result.nextPage;
  }
  return voices;
}

export async function listGenSuiteVoices(engine: GenSuiteVoiceEngine): Promise<GenSuiteVoice[]> {
  // Product rule: MiniMax exposes only voices cloned by the current user.
  // System voices must never appear in the desktop voice library.
  if (engine === 'minimax') return listVoiceType(engine, 'clone');
  return listVoiceType(engine, 'all');
}

export async function cloneGenSuiteVoice(request: GenSuiteCloneRequest): Promise<{ voiceId: string; status: string; name: string }> {
  const form = new FormData();
  form.set('engine', request.engine);
  form.set('name', request.name.trim());
  form.set('file', request.file, request.file.name);
  if (request.language) form.set('language', request.language);
  if (request.gender && request.engine === 'minimax') form.set('gender', request.gender);
  if (Number.isFinite(request.durationSeconds)) form.set('durationSeconds', String(request.durationSeconds));
  const data = await requestPublicJson(`${BASE_URL}/voices/clone`, {
    method: 'POST', body: form,
  });
  return {
    voiceId: String(data?.voiceId || ''),
    status: String(data?.status || 'processing'),
    name: String(data?.name || request.name),
  };
}

export async function getGenSuiteVoicePreview(request: {
  engine: GenSuiteVoiceEngine;
  voiceId: string;
  modelId?: string;
}): Promise<Blob> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const response = await gensuiteFetch(`${BASE_URL}/voices/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) throw clientAppError('VOICE_RATE_LIMITED');
      if (response.status === 401 || response.status === 403) throw clientAppError('VOICE_SERVICE_ACCESS_DENIED');
      throw clientAppError(response.status >= 500 ? 'VOICE_SERVICE_UNAVAILABLE' : 'VOICE_REQUEST_REJECTED');
    }
    const blob = await response.blob();
    if (!blob.size || /html|json|text\//i.test(blob.type)) throw clientAppError('VOICE_AUDIO_INVALID');
    return blob;
  } catch (error) {
    if (timedOut) throw clientAppError('VOICE_REQUEST_TIMEOUT');
    if (isPublicAppError(error)) throw error;
    throw clientAppError('VOICE_SERVICE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
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
    const abort = () => {
      clearTimeout(timer);
      reject(clientAppError('VOICE_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export class GenSuiteVoiceAdapter implements IVoiceProvider {
  readonly isLocal = false;
  private controller: AbortController | null = null;
  private jobId: string | null = null;

  constructor(readonly engine: GenSuiteVoiceEngine, private feature?: GenSuiteFeature) {}

  private async requestJson(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    context?: AppErrorContext,
  ): Promise<any> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await gensuiteFetch(url, { ...init, signal: controller.signal }, this.feature);
      // Keep the watchdog alive while the response body is being consumed too.
      return await readJson(response, context);
    } catch (error) {
      if (signal.aborted) throw clientAppError('VOICE_CANCELLED', context);
      if (timedOut) throw clientAppError('VOICE_REQUEST_TIMEOUT', context);
      if (isPublicAppError(error)
        || String(error).includes('AUTH_REQUIRED:gensuite')
        || String(error).includes('UPGRADE_REQUIRED')
        || String(error).includes('INSUFFICIENT_CREDITS')) throw error;
      throw clientAppError('VOICE_SERVICE_UNAVAILABLE', context);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async poll(jobId: string, signal: AbortSignal, context: AppErrorContext): Promise<any> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let transientFailures = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) throw clientAppError('VOICE_CANCELLED', context);
      await delay(POLL_INTERVAL_MS, signal);
      try {
        const job = await this.requestJson(`${BASE_URL}/tts/${encodeURIComponent(jobId)}`, {}, signal, context);
        const status = String(job?.status || '').toLowerCase();
        if (status === 'done') {
          if (!job.audioUrl) throw clientAppError('VOICE_AUDIO_RESULT_UNAVAILABLE', context);
          return job;
        }
        if (status === 'failed' || status === 'error') throw clientAppError('VOICE_REQUEST_REJECTED', context);
        if (status === 'cancelled') throw clientAppError('VOICE_CANCELLED', context);
        transientFailures = 0;
      } catch (error) {
        if (isPublicAppError(error) && ['VOICE_SERVICE_UNAVAILABLE', 'VOICE_REQUEST_TIMEOUT', 'VOICE_RATE_LIMITED'].includes(error.code)
          && transientFailures < 4) {
          transientFailures += 1;
          await retryDelay(transientFailures, signal);
          continue;
        }
        throw error;
      }
    }
    throw clientAppError('VOICE_REQUEST_TIMEOUT', context);
  }

  async synthesize(req: VoiceRequest): Promise<VoiceResult> {
    if (!req.text?.trim()) throw clientAppError('VOICE_INPUT_INVALID');
    if (req.text.length > MAX_DESKTOP_VOICE_CHARS) throw clientAppError('VOICE_TEXT_TOO_LONG');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const chunks = splitVoiceText(req.text, 900);
    const requestKey = voiceRequestKey(req, this.engine);
    const checkpoint = loadVoiceCheckpoint(req.projectId, req.segmentId, requestKey)
      ?? createVoiceCheckpoint(requestKey, chunks.length);
    if (checkpoint.parts.length !== chunks.length) {
      checkpoint.parts = createVoiceCheckpoint(requestKey, chunks.length).parts;
    }
    saveVoiceCheckpoint(req.projectId, req.segmentId, checkpoint);
    const partPaths: string[] = [];

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const context = { chunkNumber: index + 1, chunkCount: chunks.length };
        const part = checkpoint.parts[index];
        if (part.status === 'done' && part.audioPath) {
          const existing = await window.gensuite.audio.probe({ audioPath: part.audioPath });
          if (existing.ok) {
            partPaths.push(existing.value.audioPath);
            continue;
          }
          part.status = 'pending';
          part.audioPath = undefined;
          part.durationSec = undefined;
        }

        let job: any = null;
        if (!part.jobId) {
          const body: Record<string, unknown> = {
            engine: this.engine,
            model: req.modelId,
            voiceId: req.voiceId,
            text: chunks[index],
            settings: requestSettings(this.engine, req),
          };
          if (this.engine === 'genvoice' && req.modelId === 'genvoice-tts-2') {
            body.language = req.language === 'auto' ? 'vi' : req.language;
          }
          const idempotencyKey = `desktop-${requestKey}-${index + 1}`;
          let submit: any = null;
          for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
              submit = await this.requestJson(`${BASE_URL}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify({ ...body, idempotencyKey }),
              }, signal, context);
              break;
            } catch (error) {
              const retryableSubmit = isPublicAppError(error)
                && ['VOICE_JOB_CONFLICT', 'VOICE_SERVICE_UNAVAILABLE', 'VOICE_REQUEST_TIMEOUT', 'VOICE_RATE_LIMITED'].includes(error.code);
              if (!retryableSubmit || attempt === 4) throw error;
              await retryDelay(attempt, signal);
            }
          }
          part.jobId = String(submit?.jobId || '');
          if (!part.jobId) throw clientAppError('VOICE_RESPONSE_INVALID', context);
          part.status = 'processing';
          checkpoint.createdAt = Date.now();
          saveVoiceCheckpoint(req.projectId, req.segmentId, checkpoint);
          job = submit;
        }

        this.jobId = part.jobId || null;
        if (!job || String(job.status || '').toLowerCase() !== 'done') {
          job = await this.poll(part.jobId as string, signal, context);
        }
        const downloaded = await window.gensuite.audio.download({
          projectId: req.projectId,
          segmentId: `${req.segmentId}-${requestKey}-${index + 1}`,
          url: String(job.audioUrl),
          format: String(job?.audioFormat || ''),
        });
        if (!downloaded.ok) throw downloaded.error;
        part.status = 'done';
        part.audioPath = downloaded.value.audioPath;
        part.durationSec = downloaded.value.durationSec;
        checkpoint.createdAt = Date.now();
        saveVoiceCheckpoint(req.projectId, req.segmentId, checkpoint);
        partPaths.push(downloaded.value.audioPath);
      }

      const assembled = await window.gensuite.audio.assemble({
        projectId: req.projectId,
        segmentId: req.segmentId,
        partPaths,
      });
      if (!assembled.ok) throw assembled.error;
      return assembled.value;
    } finally {
      this.controller = null;
      this.jobId = null;
    }
  }

  cancel(): void {
    const jobId = this.jobId;
    this.controller?.abort();
    if (jobId) {
      gensuiteFetch(`${BASE_URL}/tts/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
      }, this.feature).catch(() => undefined);
    }
  }
}
