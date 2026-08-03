export type AppErrorStage =
  | 'desktop'
  | 'source'
  | 'voice'
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
  TEMP_STORAGE_PERMISSION_DENIED: { stage: 'video-preparation', cause: 'permission', retryable: true },
  TEMP_STORAGE_FULL: { stage: 'video-preparation', cause: 'storage-full', retryable: true },
  TEMP_STORAGE_UNAVAILABLE: { stage: 'video-preparation', cause: 'processing-failed', retryable: true },
  VOICE_INPUT_INVALID: { stage: 'voice', cause: 'missing-input', retryable: false },
  VOICE_TEXT_TOO_LONG: { stage: 'voice', cause: 'input-limit', retryable: false },
  VOICE_CANCELLED: { stage: 'voice', cause: 'cancelled', retryable: true },
  VOICE_JOB_CONFLICT: { stage: 'voice', cause: 'processing-failed', retryable: true },
  VOICE_SERVICE_UNAVAILABLE: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_SERVICE_ACCESS_DENIED: { stage: 'voice', cause: 'permission', retryable: true },
  VOICE_RATE_LIMITED: { stage: 'voice', cause: 'transport-failed', retryable: true },
  VOICE_REQUEST_REJECTED: { stage: 'voice', cause: 'processing-failed', retryable: true },
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
