import type { IScriptProvider, ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene, TranslateRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { buildContentPrompt, buildRewritePrompt, buildStoryboardPrompt, parseContentJson, parseStoryboardJson } from './prompt';
import { translateSegmentsReliably } from './translationReliability';
import { clientAppError } from '../clientAppError';
import { runTranslationRequest } from './translationRequest';

const MODEL = 'gemini-3.1-flash-lite';

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
        await resp.text().catch(() => '');
        if (resp.status === 400 || resp.status === 401 || resp.status === 403) throw new Error('MISSING_KEY:google');
        if (!translationMode) throw new Error('Không thể tạo nội dung lúc này. Vui lòng thử lại.');
        if (resp.status === 413) throw clientAppError('TRANSLATION_INPUT_TOO_LARGE');
        if (resp.status === 429) throw clientAppError('TRANSLATION_RATE_LIMITED');
        throw clientAppError('TRANSLATION_SERVICE_UNAVAILABLE');
      }
      const data = await resp.json().catch(() => null);
      const parts = (data as any)?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((part: any) => String(part?.text ?? '')).join('').trim() : '';
      if (!text) {
        if (translationMode) throw clientAppError('TRANSLATION_RESULT_INVALID');
        throw new Error('Không nhận được nội dung kết quả.');
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
