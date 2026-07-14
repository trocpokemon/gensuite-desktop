import type { IScriptProvider } from './types';
import type { AppSettings, ScriptEngine } from '../../shared/types';
import { GeminiScriptAdapter } from './GeminiScriptAdapter';
import { GenSuiteScriptAdapter } from './GenSuiteScriptAdapter';

export type { IScriptProvider, ContentRequest, RewriteRequest, StoryboardRequest, ScriptScene } from './types';
export { listScriptModels, type ScriptModel } from './models';

// Swap the concrete adapter at runtime based on the engine toggle. The UI only
// ever calls this factory, never the adapter classes directly. For GenSuite the
// caller passes the chosen LLM model id (empty falls back to the adapter default).
export function getScriptProvider(engine: ScriptEngine, keys: AppSettings, model?: string): IScriptProvider {
  switch (engine) {
    case 'gensuite':
      return new GenSuiteScriptAdapter(keys.gensuiteApiKey, model?.trim() || undefined);
    case 'gemini':
    default:
      return new GeminiScriptAdapter(keys.googleApiKey);
  }
}
