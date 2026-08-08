import {
  appErrorDefinition,
  isPublicAppError,
  type AppErrorCode,
  type AppErrorContext,
  type PublicAppError,
} from '../shared/appErrors';

export function clientAppError(code: AppErrorCode, context?: AppErrorContext): PublicAppError {
  const definition = appErrorDefinition(code);
  const error: PublicAppError = {
    kind: 'app-error-v1',
    code,
    stage: definition.stage,
    cause: definition.cause,
    retryable: definition.retryable,
    diagnosticId: `GS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    context,
  };
  window.gensuite?.diagnostics.record(error);
  return error;
}

/** Convert an unexpected renderer-side failure into the same safe contract used
 * by background pipelines. The original value is deliberately not copied into
 * either the public payload or diagnostics. */
export function normalizedClientAppError(
  error: unknown,
  fallbackCode: AppErrorCode,
  context?: AppErrorContext,
): PublicAppError {
  return isPublicAppError(error) ? error : clientAppError(fallbackCode, context);
}
