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
  /** Project identity used only for resumable local translation checkpoints. */
  projectId?: string;
  /** Segments to translate, in order. Only their text is sent to the LLM. */
  segments: TranscriptSegment[];
  /** Target language label (e.g. 'vietnamese', 'english'). */
  targetLanguage: string;
  /** Optional source-language hint; omit to let the model infer it. */
  sourceLanguage?: string;
  /** Renderer-only progress heartbeat. It is never included in prompts or sent
   * across the desktop bridge. */
  onProgress?: (progress: TranslationProgress) => void;
}

export interface TranslationProgress {
  completedSegments: number;
  totalSegments: number;
  batchNumber: number;
  batchCount: number;
  phase: 'requesting' | 'validating' | 'completed';
}

export interface IScriptProvider {
  readonly engine: ScriptEngine;
  generateContent(req: ContentRequest): Promise<string>;
  rewriteSelection(req: RewriteRequest): Promise<string>;
  generateStoryboard(req: StoryboardRequest): Promise<ScriptScene[]>;
  /** Translate each segment's text, preserving order and count 1:1. */
  translateSegments(req: TranslateRequest): Promise<TranscriptSegment[]>;
}
