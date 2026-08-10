export type AppErrorStage =
  | 'desktop'
  | 'source'
  | 'speech-recognition'
  | 'translation'
  | 'voice'
  | 'subtitle'
  | 'video-preparation'
  | 'video-completion'
  | 'output';

export type AppErrorCause =
  | 'missing-input'
  | 'file-not-found'
  | 'invalid-media'
  | 'input-limit'
  | 'permission'
  | 'storage-full'
  | 'component-unavailable'
  | 'start-failed'
  | 'processing-failed'
  | 'transport-failed'
  | 'cancelled'
  | 'unexpected';

export interface AppErrorDefinition {
  stage: AppErrorStage;
  cause: AppErrorCause;
  retryable: boolean;
}

/**
 * Single source of truth for the public error contract. Callers choose only a
 * code; stage/cause/retryability are derived here so contradictory payloads
 * cannot cross the desktop boundary.
 */
export const APP_ERROR_DEFINITIONS = {
  TRANSCRIPTION_INPUT_REQUIRED: { stage: 'speech-recognition', cause: 'missing-input', retryable: false },
  TRANSCRIPTION_SOURCE_UNAVAILABLE: { stage: 'speech-recognition', cause: 'file-not-found', retryable: false },
  TRANSCRIPTION_SOURCE_PERMISSION_DENIED: { stage: 'speech-recognition', cause: 'permission', retryable: false },
  TRANSCRIPTION_SOURCE_UNREADABLE: { stage: 'speech-recognition', cause: 'invalid-media', retryable: false },
  TRANSCRIPTION_AUDIO_PREPARATION_FAILED: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_AUDIO_PREPARATION_TIMEOUT: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_AUDIO_RECOVERY_FAILED: { stage: 'speech-recognition', cause: 'processing-failed', retryable: false },
  TRANSCRIPTION_COMPONENT_UNAVAILABLE: { stage: 'speech-recognition', cause: 'component-unavailable', retryable: false },
  TRANSCRIPTION_MODEL_UNAVAILABLE: { stage: 'speech-recognition', cause: 'component-unavailable', retryable: true },
  TRANSCRIPTION_MODEL_DOWNLOAD_FAILED: { stage: 'speech-recognition', cause: 'transport-failed', retryable: true },
  TRANSCRIPTION_MODEL_INVALID: { stage: 'speech-recognition', cause: 'invalid-media', retryable: true },
  TRANSCRIPTION_MODEL_PERMISSION_DENIED: { stage: 'speech-recognition', cause: 'permission', retryable: true },
  TRANSCRIPTION_MODEL_STORAGE_FULL: { stage: 'speech-recognition', cause: 'storage-full', retryable: true },
  TRANSCRIPTION_CANCELLED: { stage: 'speech-recognition', cause: 'cancelled', retryable: true },
  TRANSCRIPTION_JOB_CONFLICT: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_JOB_EXPIRED: { stage: 'speech-recognition', cause: 'file-not-found', retryable: true },
  TRANSCRIPTION_SERVICE_UNAVAILABLE: { stage: 'speech-recognition', cause: 'transport-failed', retryable: true },
  TRANSCRIPTION_REQUEST_TIMEOUT: { stage: 'speech-recognition', cause: 'transport-failed', retryable: true },
  TRANSCRIPTION_RATE_LIMITED: { stage: 'speech-recognition', cause: 'transport-failed', retryable: true },
  TRANSCRIPTION_ACCESS_DENIED: { stage: 'speech-recognition', cause: 'permission', retryable: false },
  TRANSCRIPTION_PROCESS_START_DENIED: { stage: 'speech-recognition', cause: 'permission', retryable: true },
  TRANSCRIPTION_PROCESS_START_FAILED: { stage: 'speech-recognition', cause: 'start-failed', retryable: true },
  TRANSCRIPTION_MEMORY_LIMIT: { stage: 'speech-recognition', cause: 'input-limit', retryable: true },
  TRANSCRIPTION_CHUNK_FAILED: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_CHUNK_TIMEOUT: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_RESULT_INVALID: { stage: 'speech-recognition', cause: 'invalid-media', retryable: true },
  TRANSCRIPTION_REPETITION_DETECTED: { stage: 'speech-recognition', cause: 'invalid-media', retryable: true },
  TRANSCRIPTION_NO_SPEECH: { stage: 'speech-recognition', cause: 'invalid-media', retryable: false },
  TRANSCRIPTION_TEMP_PERMISSION_DENIED: { stage: 'speech-recognition', cause: 'permission', retryable: true },
  TRANSCRIPTION_TEMP_STORAGE_FULL: { stage: 'speech-recognition', cause: 'storage-full', retryable: true },
  TRANSCRIPTION_TEMP_UNAVAILABLE: { stage: 'speech-recognition', cause: 'processing-failed', retryable: true },
  TRANSCRIPTION_UNEXPECTED: { stage: 'speech-recognition', cause: 'unexpected', retryable: true },
  TRANSLATION_INPUT_REQUIRED: { stage: 'translation', cause: 'missing-input', retryable: false },
  TRANSLATION_INPUT_TOO_LARGE: { stage: 'translation', cause: 'input-limit', retryable: true },
  TRANSLATION_ACCESS_DENIED: { stage: 'translation', cause: 'permission', retryable: false },
  TRANSLATION_AUTH_REQUIRED: { stage: 'translation', cause: 'permission', retryable: false },
  TRANSLATION_UPGRADE_REQUIRED: { stage: 'translation', cause: 'permission', retryable: false },
  TRANSLATION_CREDITS_INSUFFICIENT: { stage: 'translation', cause: 'permission', retryable: false },
  TRANSLATION_RATE_LIMITED: { stage: 'translation', cause: 'transport-failed', retryable: true },
  TRANSLATION_SERVICE_UNAVAILABLE: { stage: 'translation', cause: 'transport-failed', retryable: true },
  TRANSLATION_REQUEST_TIMEOUT: { stage: 'translation', cause: 'transport-failed', retryable: true },
  TRANSLATION_RESULT_INVALID: { stage: 'translation', cause: 'processing-failed', retryable: true },
  TRANSLATION_RESULT_INCOMPLETE: { stage: 'translation', cause: 'processing-failed', retryable: true },
  TRANSLATION_REPETITION_DETECTED: { stage: 'translation', cause: 'processing-failed', retryable: true },
  TRANSLATION_UNEXPECTED: { stage: 'translation', cause: 'unexpected', retryable: true },
  SUBTITLE_ALIGNMENT_INPUT_INVALID: { stage: 'subtitle', cause: 'missing-input', retryable: false },
  SUBTITLE_ALIGNMENT_AUDIO_UNAVAILABLE: { stage: 'subtitle', cause: 'file-not-found', retryable: true },
  SUBTITLE_ALIGNMENT_TIMEOUT: { stage: 'subtitle', cause: 'processing-failed', retryable: true },
  SUBTITLE_ALIGNMENT_FAILED: { stage: 'subtitle', cause: 'processing-failed', retryable: true },
  SUBTITLE_ALIGNMENT_RESULT_INVALID: { stage: 'subtitle', cause: 'invalid-media', retryable: true },
  SUBTITLE_ALIGNMENT_UNEXPECTED: { stage: 'subtitle', cause: 'unexpected', retryable: true },
  VIDEO_SOURCE_REQUIRED: { stage: 'source', cause: 'missing-input', retryable: false },
  VIDEO_SEGMENTS_EMPTY: { stage: 'voice', cause: 'missing-input', retryable: false },
  VIDEO_SOURCE_UNAVAILABLE: { stage: 'source', cause: 'file-not-found', retryable: false },
  VIDEO_SOURCE_PERMISSION_DENIED: { stage: 'source', cause: 'permission', retryable: false },
  VIDEO_SOURCE_UNREADABLE: { stage: 'source', cause: 'invalid-media', retryable: false },
  VIDEO_SOURCE_VALIDATION_TIMEOUT: { stage: 'source', cause: 'processing-failed', retryable: true },
  VIDEO_SEGMENT_AUDIO_UNAVAILABLE: { stage: 'voice', cause: 'file-not-found', retryable: true },
  VIDEO_SEGMENT_AUDIO_PERMISSION_DENIED: { stage: 'voice', cause: 'permission', retryable: true },
  VIDEO_SEGMENT_AUDIO_UNREADABLE: { stage: 'voice', cause: 'invalid-media', retryable: true },
  VIDEO_SEGMENT_AUDIO_VALIDATION_TIMEOUT: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VIDEO_SEGMENT_TIMING_INVALID: { stage: 'video-preparation', cause: 'invalid-media', retryable: false },
  BACKGROUND_AUDIO_UNAVAILABLE: { stage: 'source', cause: 'file-not-found', retryable: true },
  BACKGROUND_AUDIO_PERMISSION_DENIED: { stage: 'source', cause: 'permission', retryable: true },
  BACKGROUND_AUDIO_UNREADABLE: { stage: 'source', cause: 'invalid-media', retryable: true },
  BACKGROUND_AUDIO_VALIDATION_TIMEOUT: { stage: 'source', cause: 'processing-failed', retryable: true },
  VIDEO_COMPONENT_UNAVAILABLE: { stage: 'video-preparation', cause: 'component-unavailable', retryable: false },
  VIDEO_TOO_MANY_SEGMENTS: { stage: 'video-preparation', cause: 'input-limit', retryable: false },
  VIDEO_PROCESS_START_DENIED: { stage: 'video-completion', cause: 'permission', retryable: true },
  VIDEO_PROCESS_START_FAILED: { stage: 'video-completion', cause: 'start-failed', retryable: true },
  VIDEO_AUDIO_PREPARATION_FAILED: { stage: 'video-preparation', cause: 'processing-failed', retryable: true },
  VIDEO_AUDIO_PREPARATION_TIMEOUT: { stage: 'video-preparation', cause: 'processing-failed', retryable: true },
  VIDEO_PROCESS_FAILED: { stage: 'video-completion', cause: 'processing-failed', retryable: true },
  VIDEO_COMPLETION_TIMEOUT: { stage: 'video-completion', cause: 'processing-failed', retryable: true },
  VIDEO_OUTPUT_VALIDATION_TIMEOUT: { stage: 'output', cause: 'processing-failed', retryable: true },
  VIDEO_OUTPUT_INVALID: { stage: 'output', cause: 'invalid-media', retryable: true },
  OUTPUT_DIRECTORY_UNAVAILABLE: { stage: 'output', cause: 'file-not-found', retryable: true },
  OUTPUT_PERMISSION_DENIED: { stage: 'output', cause: 'permission', retryable: true },
  OUTPUT_STORAGE_FULL: { stage: 'output', cause: 'storage-full', retryable: true },
  OUTPUT_WRITE_FAILED: { stage: 'output', cause: 'processing-failed', retryable: true },
  OUTPUT_RECOVERY_FAILED: { stage: 'output', cause: 'processing-failed', retryable: true },
  CAPCUT_EXPORT_INPUT_INVALID: { stage: 'output', cause: 'missing-input', retryable: false },
  CAPCUT_SOURCE_UNAVAILABLE: { stage: 'output', cause: 'file-not-found', retryable: true },
  CAPCUT_SOURCE_UNREADABLE: { stage: 'output', cause: 'invalid-media', retryable: true },
  CAPCUT_VOICE_UNAVAILABLE: { stage: 'output', cause: 'file-not-found', retryable: true },
  CAPCUT_VOICE_UNREADABLE: { stage: 'output', cause: 'invalid-media', retryable: true },
  CAPCUT_TIMELINE_INVALID: { stage: 'output', cause: 'invalid-media', retryable: false },
  CAPCUT_SEGMENT_LIMIT: { stage: 'output', cause: 'input-limit', retryable: false },
  CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE: { stage: 'output', cause: 'file-not-found', retryable: true },
  CAPCUT_APP_UNAVAILABLE: { stage: 'output', cause: 'component-unavailable', retryable: false },
  CAPCUT_APP_LAUNCH_FAILED: { stage: 'output', cause: 'start-failed', retryable: true },
  CAPCUT_EDITOR_BUSY: { stage: 'output', cause: 'processing-failed', retryable: true },
  CAPCUT_EXPORT_PERMISSION_DENIED: { stage: 'output', cause: 'permission', retryable: true },
  CAPCUT_EXPORT_STORAGE_FULL: { stage: 'output', cause: 'storage-full', retryable: true },
  CAPCUT_EXPORT_COMPONENT_UNAVAILABLE: { stage: 'output', cause: 'component-unavailable', retryable: false },
  CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE: { stage: 'output', cause: 'component-unavailable', retryable: true },
  CAPCUT_EXPORT_COMPATIBILITY_FAILED: { stage: 'output', cause: 'processing-failed', retryable: true },
  CAPCUT_EXPORT_TIMEOUT: { stage: 'output', cause: 'processing-failed', retryable: true },
  CAPCUT_EXPORT_FAILED: { stage: 'output', cause: 'processing-failed', retryable: true },
  CAPCUT_EXPORT_RECOVERY_FAILED: { stage: 'output', cause: 'processing-failed', retryable: false },
  LOCALIZE_JOB_INPUT_INVALID: { stage: 'desktop', cause: 'missing-input', retryable: false },
  LOCALIZE_JOB_NOT_FOUND: { stage: 'desktop', cause: 'file-not-found', retryable: true },
  LOCALIZE_JOB_OWNERSHIP_CONFLICT: { stage: 'desktop', cause: 'processing-failed', retryable: true },
  LOCALIZE_CHECKPOINT_INVALID: { stage: 'desktop', cause: 'invalid-media', retryable: true },
  LOCALIZE_CHECKPOINT_UNAVAILABLE: { stage: 'desktop', cause: 'processing-failed', retryable: true },
  LOCALIZE_JOB_UNEXPECTED: { stage: 'desktop', cause: 'unexpected', retryable: true },
  TEMP_STORAGE_PERMISSION_DENIED: { stage: 'video-preparation', cause: 'permission', retryable: true },
  TEMP_STORAGE_FULL: { stage: 'video-preparation', cause: 'storage-full', retryable: true },
  TEMP_STORAGE_UNAVAILABLE: { stage: 'video-preparation', cause: 'processing-failed', retryable: true },
  VOICE_INPUT_INVALID: { stage: 'voice', cause: 'missing-input', retryable: false },
  VOICE_TEXT_TOO_LONG: { stage: 'voice', cause: 'input-limit', retryable: false },
  VOICE_AUTH_REQUIRED: { stage: 'voice', cause: 'permission', retryable: false },
  VOICE_UPGRADE_REQUIRED: { stage: 'voice', cause: 'permission', retryable: false },
  VOICE_CREDITS_INSUFFICIENT: { stage: 'voice', cause: 'permission', retryable: false },
  VOICE_CANCELLED: { stage: 'voice', cause: 'cancelled', retryable: true },
  VOICE_JOB_CONFLICT: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_SERVICE_UNAVAILABLE: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_SERVICE_ACCESS_DENIED: { stage: 'voice', cause: 'permission', retryable: false },
  VOICE_RATE_LIMITED: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_REQUEST_REJECTED: { stage: 'voice', cause: 'processing-failed', retryable: false },
  VOICE_REQUEST_TIMEOUT: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_RESPONSE_INVALID: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_AUDIO_RESULT_UNAVAILABLE: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_AUDIO_DOWNLOAD_FAILED: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_AUDIO_DOWNLOAD_TIMEOUT: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_AUDIO_INVALID: { stage: 'voice', cause: 'invalid-media', retryable: true },
  VOICE_COMPONENT_UNAVAILABLE: { stage: 'voice', cause: 'component-unavailable', retryable: false },
  VOICE_PROCESS_START_DENIED: { stage: 'voice', cause: 'permission', retryable: true },
  VOICE_PROCESS_START_FAILED: { stage: 'voice', cause: 'start-failed', retryable: true },
  VOICE_AUDIO_ASSEMBLY_FAILED: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_AUDIO_ASSEMBLY_TIMEOUT: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_AUDIO_VALIDATION_TIMEOUT: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_OUTPUT_PERMISSION_DENIED: { stage: 'voice', cause: 'permission', retryable: true },
  VOICE_OUTPUT_STORAGE_FULL: { stage: 'voice', cause: 'storage-full', retryable: true },
  VOICE_OUTPUT_UNAVAILABLE: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_OUTPUT_RECOVERY_FAILED: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_UNEXPECTED: { stage: 'voice', cause: 'unexpected', retryable: true },
  DESKTOP_BRIDGE_UNAVAILABLE: { stage: 'desktop', cause: 'transport-failed', retryable: true },
  UNEXPECTED: { stage: 'video-completion', cause: 'unexpected', retryable: true },
} as const satisfies Record<string, AppErrorDefinition>;

export type AppErrorCode = keyof typeof APP_ERROR_DEFINITIONS;

export interface AppErrorContext {
  segmentNumber?: number;
  segmentCount?: number;
  groupNumber?: number;
  groupCount?: number;
  chunkNumber?: number;
  chunkCount?: number;
}

/** Safe error payload allowed to cross into the renderer. It intentionally
 * excludes paths, source text, raw command output, URLs and system details. */
export interface PublicAppError {
  kind: 'app-error-v1';
  code: AppErrorCode;
  stage: AppErrorStage;
  cause: AppErrorCause;
  retryable: boolean;
  diagnosticId: string;
  context?: AppErrorContext;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PublicAppError };

const APP_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(APP_ERROR_DEFINITIONS));
const APP_ERROR_ROOT_KEYS = new Set(['kind', 'code', 'stage', 'cause', 'retryable', 'diagnosticId', 'context']);
const APP_ERROR_CONTEXT_KEYS = new Set(['segmentNumber', 'segmentCount', 'groupNumber', 'groupCount', 'chunkNumber', 'chunkCount']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function appErrorDefinition(code: AppErrorCode): AppErrorDefinition {
  return APP_ERROR_DEFINITIONS[code];
}

export function isPublicAppError(value: unknown): value is PublicAppError {
  if (!isRecord(value) || !hasOnlyKeys(value, APP_ERROR_ROOT_KEYS) || value.kind !== 'app-error-v1') return false;
  if (typeof value.code !== 'string' || !APP_ERROR_CODES.has(value.code)) return false;

  const definition = APP_ERROR_DEFINITIONS[value.code as AppErrorCode];
  const contextIsSafe = value.context === undefined || (
    isRecord(value.context)
    && hasOnlyKeys(value.context, APP_ERROR_CONTEXT_KEYS)
    && Object.keys(value.context).length > 0
    && Object.values(value.context).every((item) => typeof item === 'number' && Number.isInteger(item) && item > 0)
  );

  return value.stage === definition.stage
    && value.cause === definition.cause
    && value.retryable === definition.retryable
    && typeof value.diagnosticId === 'string'
    && /^GS-[A-Z0-9]{8}$/.test(value.diagnosticId)
    && contextIsSafe;
}

export function isIpcResult<T = unknown>(
  value: unknown,
  isValue: (candidate: unknown) => candidate is T = ((_candidate: unknown): _candidate is T => true),
): value is IpcResult<T> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) {
    return Object.keys(value).length === 2
      && Object.prototype.hasOwnProperty.call(value, 'value')
      && isValue(value.value);
  }
  return Object.keys(value).length === 2
    && Object.prototype.hasOwnProperty.call(value, 'error')
    && isPublicAppError(value.error);
}
