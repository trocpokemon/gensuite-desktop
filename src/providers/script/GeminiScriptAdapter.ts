import type { IScriptProvider, ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene, TranslateRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { buildContentPrompt, buildRewritePrompt, buildStoryboardPrompt, buildTranslatePrompt, parseContentJson, parseStoryboardJson, parseTranslationJson } from './prompt';

const MODEL = 'gemini-3.1-flash-lite';

export class GeminiScriptAdapter implements IScriptProvider {
  readonly engine = 'gemini' as const;
  constructor(private apiKey: string) {}

  private async call(prompt: string): Promise<string> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:google');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(this.apiKey.trim())}`;
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.85 },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (resp.status === 400 || resp.status === 403) throw new Error('MISSING_KEY:google');
      throw new Error(`Gemini lỗi ${resp.status}: ${text.slice(0, 300)}`);
    }
    const data = await resp.json().catch(() => null);
    const parts = (data as any)?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((part: any) => String(part?.text ?? '')).join('').trim() : '';
    if (!text) throw new Error('Gemini không trả về nội dung.');
    return text;
  }

  async generateContent(req: ContentRequest): Promise<string> { return parseContentJson(await this.call(buildContentPrompt(req))); }
  async rewriteSelection(req: RewriteRequest): Promise<string> { return parseContentJson(await this.call(buildRewritePrompt(req))); }
  async generateStoryboard(req: StoryboardRequest): Promise<ScriptScene[]> { return parseStoryboardJson(await this.call(buildStoryboardPrompt(req))); }
  async translateSegments(req: TranslateRequest): Promise<TranscriptSegment[]> {
    if (!req.segments.length) return [];
    return parseTranslationJson(await this.call(buildTranslatePrompt(req)), req.segments);
  }
}
