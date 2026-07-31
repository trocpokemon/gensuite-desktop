import type { TranscriptionEngine, AppSettings } from '../../shared/types';
import type { ITranscriptionProvider } from './types';
import { LocalWhisperAdapter } from './LocalWhisperAdapter';
import { GenSuiteSttAdapter } from './GenSuiteSttAdapter';
import type { GenSuiteFeature } from '../../lib/gensuiteAuth';

export type { ITranscriptionProvider, TranscribeRequest } from './types';

// Swap transcription adapters at runtime based on the engine toggle. The UI holds
// only ITranscriptionProvider, never a concrete class — the Adapter Pattern
// boundary, matching getVoiceProvider / getScriptProvider. Two engines only:
// 'local' (free whisper.cpp) and 'cloud' (paid GenSuite STT).
export function getTranscriptionProvider(engine: TranscriptionEngine, keys: AppSettings, feature?: GenSuiteFeature): ITranscriptionProvider {
  switch (engine) {
    case 'cloud':
      void keys;
      return new GenSuiteSttAdapter(feature);
    case 'local':
    default:
      return new LocalWhisperAdapter();
  }
}
