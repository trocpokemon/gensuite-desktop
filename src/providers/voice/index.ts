import type { VoiceEngine, AppSettings } from '../../shared/types';
import type { IVoiceProvider } from './types';
import { EdgeTtsAdapter } from './EdgeTtsAdapter';
import { GenSuiteVoiceAdapter } from './GenSuiteVoiceAdapter';
import type { GenSuiteFeature } from '../../lib/gensuiteAuth';

export type { IVoiceProvider, VoiceRequest, VoiceResult } from './types';

// Swap voice adapters at runtime based on the engine toggle. The UI holds only
// IVoiceProvider, never a concrete class — that's the Adapter Pattern boundary.
export function getVoiceProvider(engine: VoiceEngine, keys: AppSettings, feature?: GenSuiteFeature): IVoiceProvider {
  switch (engine) {
    case 'edgetts':
      return new EdgeTtsAdapter();
    case 'genvoice':
    case 'elevenlabs':
    case 'minimax':
      void keys;
      return new GenSuiteVoiceAdapter(engine, feature);
    default:
      return new EdgeTtsAdapter();
  }
}

// The engine every "rescue to cloud" action switches to.
export const RESCUE_ENGINE: VoiceEngine = 'genvoice';
