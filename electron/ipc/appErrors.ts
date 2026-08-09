import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import {
  appErrorDefinition,
  type AppErrorCode,
  type AppErrorContext,
  type IpcResult,
  type PublicAppError,
} from '../../src/shared/appErrors';

type SafeDiagnosticValue = string | number | boolean | undefined;
export type SafeDiagnostics = Record<string, SafeDiagnosticValue>;

interface StoredDiagnostic {
  diagnosticId: string;
  diagnostics: SafeDiagnostics;
}

const MAX_STORED_DIAGNOSTICS = 100;
const storedDiagnostics = new Map<string, StoredDiagnostic>();

const SAFE_DIAGNOSTIC_KEYS = new Set([
  'operation',
  'activeStage',
  'segmentCount',
  'groupCount',
  'groupNumber',
  'usedBatches',
  'processKind',
  'systemCode',
  'exitCode',
  'classifier',
  'failureType',
  'errorType',
  'chunkCount',
  'chunkNumber',
  'textLength',
  'attempt',
  'statusCode',
]);

function sanitizedDiagnostics(values: SafeDiagnostics): SafeDiagnostics {
  const result: SafeDiagnostics = {};
  for (const [key, value] of Object.entries(values)) {
    if (!SAFE_DIAGNOSTIC_KEYS.has(key) || value === undefined) continue;
    if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) result[key] = value;
  }
  return result;
}

function rememberInternalDiagnostic(diagnosticId: string, diagnostics: SafeDiagnostics): void {
  storedDiagnostics.set(diagnosticId, {
    diagnosticId,
    diagnostics: sanitizedDiagnostics(diagnostics),
  });
  while (storedDiagnostics.size > MAX_STORED_DIAGNOSTICS) {
    const oldest = storedDiagnostics.keys().next().value as string | undefined;
    if (!oldest) break;
    storedDiagnostics.delete(oldest);
  }
}

/** Returns only allowlisted metadata for the single matching support code. */
export function internalDiagnosticFor(diagnosticId: string): SafeDiagnostics | null {
  const stored = storedDiagnostics.get(diagnosticId);
  return stored ? { ...stored.diagnostics } : null;
}

export class AppFailure extends Error {
  readonly definition;

  constructor(
    readonly code: AppErrorCode,
    readonly context?: AppErrorContext,
    readonly internalDiagnostics: SafeDiagnostics = {},
  ) {
    super(code);
    this.name = 'AppFailure';
    this.definition = appErrorDefinition(code);
  }
}

export function appFailure(
  code: AppErrorCode,
  context?: AppErrorContext,
  internalDiagnostics: SafeDiagnostics = {},
): AppFailure {
  return new AppFailure(code, context, internalDiagnostics);
}

export function appSuccess<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function safeUnexpectedMetadata(error: unknown): SafeDiagnostics {
  if (error instanceof AppFailure) return { failureType: 'known', ...error.internalDiagnostics };
  const record = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : null;
  const name = typeof record?.name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(record.name)
    ? record.name
    : typeof error;
  const systemCode = typeof record?.code === 'string' && /^[A-Z0-9_-]{1,40}$/i.test(record.code)
    ? record.code.toUpperCase()
    : undefined;
  return { failureType: 'unexpected', errorType: name, systemCode };
}

export function appFailureResult<T>(
  error: unknown,
  fallbackCode: AppErrorCode,
  diagnostics: SafeDiagnostics = {},
): IpcResult<T> {
  const known = error instanceof AppFailure ? error : null;
  const code = known?.code ?? fallbackCode;
  const definition = appErrorDefinition(code);
  const diagnosticId = `GS-${randomUUID().slice(0, 8).toUpperCase()}`;
  const publicError: PublicAppError = {
    kind: 'app-error-v1',
    code,
    stage: definition.stage,
    cause: definition.cause,
    retryable: definition.retryable,
    diagnosticId,
    context: known?.context,
  };

  // Only normalized, allowlisted metadata reaches diagnostics. Paths, source
  // text, command output and service details never leave the process boundary.
  const internalDiagnostics = sanitizedDiagnostics({
    ...safeUnexpectedMetadata(error),
    ...diagnostics,
  });
  rememberInternalDiagnostic(diagnosticId, internalDiagnostics);

  log.error('operation failed', {
    diagnosticId,
    code: publicError.code,
    stage: publicError.stage,
    cause: publicError.cause,
    retryable: publicError.retryable,
    ...publicError.context,
    ...internalDiagnostics,
  });

  return { ok: false, error: publicError };
}
