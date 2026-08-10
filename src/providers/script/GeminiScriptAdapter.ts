import type { IScriptProvider, ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene, TranslateRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { buildContentPrompt, buildRewritePrompt, buildStoryboardPrompt, parseContentJson, parseStoryboardJson } from './prompt';
import { translateSegmentsReliably } from './translationReliability';
import { clientAppError } from '../clientAppError';
import { runTranslationRequest } from './translationRequest';
import { classifyGoogleApiFailure, googleResponseWasBlocked, type GoogleApiFailureKind } from '../../lib/googleApiErrors';

const MODEL = 'gemini-3.1-flash-lite';

const googleFailure = (kind: GoogleApiFailureKind, translationMode: boolean, status: number) => {
  const context = { providerStatus: status };
  if (translationMode) {
    if (kind === 'api-key-invalid') return clientAppError('TRANSLATION_API_KEY_INVALID', context);
    if (kind === 'access-denied') return clientAppError('TRANSLATION_ACCESS_DENIED', context);
    if (kind === 'quota-exhausted') return clientAppError('TRANSLATION_QUOTA_EXHAUSTED', context);
    if (kind === 'rate-limited') return clientAppError('TRANSLATION_RATE_LIMITED', context);
    if (kind === 'model-unavailable') return clientAppError('TRANSLATION_MODEL_UNAVAILABLE', context);
    if (kind === 'content-blocked') return clientAppError('TRANSLATION_CONTENT_BLOCKED', context);
    if (kind === 'request-rejected') return clientAppError('TRANSLATION_REQUEST_REJECTED', context);
    return clientAppError('TRANSLATION_SERVICE_UNAVAILABLE', context);
  }
  if (kind === 'api-key-invalid') return clientAppError('CONTENT_API_KEY_INVALID', context);
  if (kind === 'access-denied') return clientAppError('CONTENT_ACCESS_DENIED', context);
  if (kind === 'quota-exhausted') return clientAppError('CONTENT_QUOTA_EXHAUSTED', context);
  if (kind === 'rate-limited') return clientAppError('CONTENT_RATE_LIMITED', context);
  if (kind === 'model-unavailable') return clientAppError('CONTENT_MODEL_UNAVAILABLE', context);
  if (kind === 'content-blocked') return clientAppError('CONTENT_BLOCKED', context);
  if (kind === 'request-rejected') return clientAppError('CONTENT_REQUEST_REJECTED', context);
  return clientAppError('CONTENT_SERVICE_UNAVAILABLE', context);
};

export class GeminiScriptAdapter implements IScriptProvider {
  readonly engine = 'gemini' as const;
  constructor(private apiKey: string) {}

  private async call(prompt: string, temperature = 0.85, translationMode = false): Promise<string> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:google');
    const execute = async (signal?: AbortSignal) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(this.apiKey.trim())}`;
      const resp = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature },
        }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null);
        throw googleFailure(classifyGoogleApiFailure(resp.status, payload), translationMode, resp.status);
      }
      const data = await resp.json().catch(() => null);
      const parts = (data as any)?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((part: any) => String(part?.text ?? '')).join('').trim() : '';
      if (!text) {
        if (googleResponseWasBlocked(data)) throw googleFailure('content-blocked', translationMode, resp.status);
        if (translationMode) throw clientAppError('TRANSLATION_RESULT_INVALID', { providerStatus: resp.status });
        throw clientAppError('CONTENT_RESPONSE_INVALID', { providerStatus: resp.status });
      }
      return text;
    };
    return translationMode ? await runTranslationRequest(execute) : await execute();
  }

  async generateContent(req: ContentRequest): Promise<string> { return parseContentJson(await this.call(buildContentPrompt(req))); }
  async rewriteSelection(req: RewriteRequest): Promise<string> { return parseContentJson(await this.call(buildRewritePrompt(req))); }
  async generateStoryboard(req: StoryboardRequest): Promise<ScriptScene[]> { return parseStoryboardJson(await this.call(buildStoryboardPrompt(req))); }
  async translateSegments(req: TranslateRequest): Promise<TranscriptSegment[]> {
    return await translateSegmentsReliably(req, this.engine, (prompt) => this.call(prompt, 0.1, true));
  }
}
