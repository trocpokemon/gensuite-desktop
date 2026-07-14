import type { ScriptEngine, TranscriptSegment } from '../../shared/types';

export interface ContentRequest {
  idea: string;
  tone: string;
  masterPrompt: string;
  targetAudience: string;
  wordCount: number;
}

export interface RewriteRequest {
  fullContent: string;
  selectedText: string;
  instruction: string;
}

export interface StoryboardRequest {
  content: string;
  visualStyle: string;
  negativePrompt: string;
}

export interface ScriptScene {
  narration: string;
  imagePrompt: string;
  keyword: string;
}

export interface TranslateRequest {
  /** Segments to translate, in order. Only their text is sent to the LLM. */
  segments: TranscriptSegment[];
  /** Target language label (e.g. 'vietnamese', 'english'). */
  targetLanguage: string;
  /** Optional source-language hint; omit to let the model infer it. */
  sourceLanguage?: string;
}

export interface IScriptProvider {
  readonly engine: ScriptEngine;
  generateContent(req: ContentRequest): Promise<string>;
  rewriteSelection(req: RewriteRequest): Promise<string>;
  generateStoryboard(req: StoryboardRequest): Promise<ScriptScene[]>;
  /** Translate each segment's text, preserving order and count 1:1. */
  translateSegments(req: TranslateRequest): Promise<TranscriptSegment[]>;
}
