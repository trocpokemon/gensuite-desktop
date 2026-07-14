import type { AppSettings } from '../../shared/types';
import type { IImageProvider, ImageEngine } from './types';
import { GenSuiteImageAdapter } from './GenSuiteImageAdapter';

export type { IImageProvider, ImageEngine, ImageGenRequest } from './types';

// Both AI image engines (Gemini, ChatGPT) run through the same GenSuite paid
// Developer API; only the underlying model id differs. The UI calls this factory
// and never the adapter class directly.
export function getImageProvider(engine: ImageEngine, keys: AppSettings): IImageProvider {
  return new GenSuiteImageAdapter(engine, keys.gensuiteApiKey);
}
