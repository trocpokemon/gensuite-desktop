import type { TranscriptionEngine, TranscriptSegment, WhisperModelName } from '../../shared/types';

export interface TranscribeRequest {
  projectId: string;
  /** Absolute path (inside the project dir) of the imported/downloaded source media. */
  sourcePath: string;
  /** GGML model to use for the local engine (ignored by the cloud engine). */
  model: WhisperModelName;
  /** Optional source-language hint (e.g. 'en'); omit to auto-detect. */
  language?: string;
}

// Abstraction the localize UI depends on. Concrete adapters (local whisper.cpp,
// cloud GenSuite STT) are swapped at runtime via the transcription toggle.
export interface ITranscriptionProvider {
  readonly engine: TranscriptionEngine;
  /** True for the fully local engine (whisper.cpp) that needs no API key. */
  readonly isLocal: boolean;
  transcribe(req: TranscribeRequest): Promise<TranscriptSegment[]>;
}
