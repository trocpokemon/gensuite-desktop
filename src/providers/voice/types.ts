import type { VoiceEngine } from '../../shared/types';

// A synthesized segment: the adapter has already ensured the audio lives on disk
// (every adapter writes its Blob via the audio.write IPC), so the timeline step
// can hand paths straight to FFmpeg.
export interface VoiceResult {
  /** Absolute path to the audio file inside the project dir. */
  audioPath: string;
  /** Duration in seconds (measured in the renderer via an <audio> probe). */
  durationSec: number;
}

export interface VoiceRequest {
  projectId: string;
  /** Stable id for the segment/scene — used as the output filename. */
  segmentId: string;
  text: string;
  /** Provider-specific voice id (empty → adapter default). */
  voiceId: string;
  modelId: string;
  language: string;
  speed: number;
  temperature: number;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  pitch: number;
  volume: number;
  deliveryMode: 'STABLE' | 'BALANCED' | 'CREATIVE';
}

// Abstraction the UI depends on. Concrete adapters (edge-tts, GenVoice,
// ElevenLabs, MiniMax cloud) are swapped at runtime via the voice engine toggle.
export interface IVoiceProvider {
  readonly engine: VoiceEngine;
  /** True for the free, keyless engine (edge-tts) that can be cancelled mid-run. */
  readonly isLocal: boolean;
  synthesize(req: VoiceRequest): Promise<VoiceResult>;
  /** Cancel an in-flight local job, if this adapter supports it. */
  cancel?(): void;
}
