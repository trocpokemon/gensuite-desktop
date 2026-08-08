import type { HardwareInfo } from './types';
import type { PublicAppError } from './appErrors';

const STORAGE_KEY = 'gensuite_safe_diagnostics_v1';

interface SafeDiagnosticRecord {
  timestamp: string;
  code: string;
  stage: string;
  cause: string;
  retryable: boolean;
  diagnosticId: string;
  context?: Record<string, number>;
}

function loadRecords(): SafeDiagnosticRecord[] {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as SafeDiagnosticRecord[];
    return Array.isArray(records) ? records.slice(-20) : [];
  } catch { return []; }
}

export function rememberDiagnostic(error: PublicAppError): void {
  const records = loadRecords();
  if (records.some((record) => record.diagnosticId === error.diagnosticId)) return;
  records.push({
    timestamp: new Date().toISOString(),
    code: error.code,
    stage: error.stage,
    cause: error.cause,
    retryable: error.retryable,
    diagnosticId: error.diagnosticId,
    context: error.context ? { ...error.context } : undefined,
  });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-20))); } catch { /* storage is optional */ }
}

export async function diagnosticSummary(): Promise<string> {
  let hardware: HardwareInfo | null = null;
  try { hardware = await window.gensuite.hardware.scan(); } catch { hardware = null; }
  return JSON.stringify({
    appVersion: __APP_VERSION__,
    generatedAt: new Date().toISOString(),
    platform: navigator.platform,
    hardwareClass: hardware ? {
      lowSpec: hardware.lowSpec,
      performanceClass: hardware.lowSpec ? 'limited' : 'standard',
    } : null,
    recentErrors: loadRecords(),
  }, null, 2);
}

/** A compact support payload for one specific failure. Unlike the diagnostics
 * summary in Settings, this intentionally excludes all previous failures. */
export function diagnosticSummaryForError(error: PublicAppError, occurredAt: string): string {
  return JSON.stringify({
    appVersion: __APP_VERSION__,
    occurredAt,
    error: {
      code: error.code,
      stage: error.stage,
      cause: error.cause,
      retryable: error.retryable,
      diagnosticId: error.diagnosticId,
      context: error.context ? { ...error.context } : undefined,
    },
  }, null, 2);
}
