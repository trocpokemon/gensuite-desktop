import type { IScriptProvider, ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene, TranslateRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';
import { buildContentPrompt, buildRewritePrompt, buildStoryboardPrompt, buildTranslatePrompt, parseContentJson, parseStoryboardJson, parseTranslationJson } from './prompt';

// GenSuite paid script API. Developers authenticate with a `gsk_live_...` key and
// hit the public Developer API (api.gensuite.site/v1). Script generation is the
// synchronous POST /v1/scripts endpoint — it takes a system + user prompt, runs
// the chosen LLM (Claude by default), charges GenVoice credits, and returns the
// finished text. See supabase/functions/api-v1 in the Gensuite-Audio repo.
const BASE_URL = 'https://api.gensuite.site/v1';

// Claude Fable 5 — Anthropic's storytelling model, tuned for long-form narrative
// scripts. This is the paid Claude flow the app defaults to; the id must match a
// row in public.llm_models (is_active = true).
const DEFAULT_MODEL = 'anthropic/claude-fable-5';

const SYSTEM_PROMPT =
  'Bạn là biên kịch chuyên nghiệp cho video kể chuyện. Tuân thủ chính xác yêu cầu của người dùng và chỉ trả về đúng JSON được yêu cầu, không thêm lời dẫn hay chú thích.';

export class GenSuiteScriptAdapter implements IScriptProvider {
  readonly engine = 'gensuite' as const;
  constructor(private apiKey: string, private model: string = DEFAULT_MODEL) {}

  private async call(prompt: string): Promise<string> {
    if (!this.apiKey?.trim()) throw new Error('MISSING_KEY:gensuite');
    const resp = await fetch(`${BASE_URL}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey.trim()}` },
      body: JSON.stringify({ model: this.model, systemPrompt: SYSTEM_PROMPT, prompt }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null as any);
      const code = String(data?.error ?? '');
      const message = String(data?.message ?? '');
      if (resp.status === 401 || resp.status === 403 || code === 'INVALID_API_KEY') throw new Error('MISSING_KEY:gensuite');
      if (resp.status === 402 || code === 'INSUFFICIENT_CREDITS') throw new Error('Tài khoản GenSuite không đủ credits để tạo nội dung.');
      throw new Error(`GenSuite lỗi ${resp.status}: ${message || code || 'yêu cầu thất bại'}`.slice(0, 300));
    }
    const data = await resp.json().catch(() => null);
    const text = String((data as any)?.text ?? '').trim();
    if (!text) throw new Error('GenSuite không trả về nội dung.');
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
