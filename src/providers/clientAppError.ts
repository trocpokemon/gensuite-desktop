import { appErrorDefinition, type AppErrorCode, type AppErrorContext, type PublicAppError } from '../shared/appErrors';

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
