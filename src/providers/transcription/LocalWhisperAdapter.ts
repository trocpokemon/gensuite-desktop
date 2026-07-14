import type { ITranscriptionProvider, TranscribeRequest } from './types';
import type { TranscriptSegment } from '../../shared/types';

// Local speech recognition via the bundled whisper.cpp binary (main process).
// Audio extraction + transcription both run over the whisper IPC bridge; no API
// key is required, but the GGML model is downloaded on first use.
export class LocalWhisperAdapter implements ITranscriptionProvider {
  readonly engine = 'local' as const;
  readonly isLocal = true;

  async transcribe(req: TranscribeRequest): Promise<TranscriptSegment[]> {
    const wavPath = await window.gensuite.whisper.extract({
      projectId: req.projectId,
      sourcePath: req.sourcePath,
    });
    return window.gensuite.whisper.transcribe({
      projectId: req.projectId,
      wavPath,
      model: req.model,
      language: req.language,
    });
  }
}
