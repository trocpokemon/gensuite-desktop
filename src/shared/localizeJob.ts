import type { PublicAppError } from './appErrors';

export const LOCALIZE_JOB_SCHEMA_VERSION = 1 as const;

export const LOCALIZE_STAGE_ORDER = ['download', 'recognition', 'translation', 'voice', 'capcut'] as const;
export type LocalizeJobStage = typeof LOCALIZE_STAGE_ORDER[number];

export type LocalizeJobStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'completed';

export type LocalizeStageStatus =
  | 'pending'
  | 'preflight'
  | 'running'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface LocalizeStageProgress {
  stage: LocalizeJobStage;
  status: LocalizeStageStatus;
  percent: number;
  completedUnits?: number;
  totalUnits?: number;
  label?: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  artifactFingerprint?: string;
  diagnosticId?: string;
}

export interface LocalizeJobFailure {
  error: PublicAppError;
  occurredAt: string;
}

/**
 * Durable, renderer-safe control record for one localization project. It never
 * contains source URLs, customer text, absolute paths or raw process output.
 */
export interface LocalizeJobManifest {
  schemaVersion: typeof LOCALIZE_JOB_SCHEMA_VERSION;
  projectId: string;
  operationId: string;
  status: LocalizeJobStatus;
  activeStage: LocalizeJobStage;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  sourceFingerprint?: string;
  configFingerprint?: string;
  steps: Record<LocalizeJobStage, LocalizeStageProgress>;
  failure?: LocalizeJobFailure;
  cancellationRequested?: boolean;
}

export interface LocalizeJobStartArgs {
  projectId: string;
  sourceFingerprint?: string;
  configFingerprint?: string;
  restart?: boolean;
}

export interface LocalizeJobIdentity {
  projectId: string;
  operationId: string;
}

export interface LocalizeJobUpdateArgs extends LocalizeJobIdentity {
  stage: LocalizeJobStage;
  status?: LocalizeJobStatus;
  stageStatus?: LocalizeStageStatus;
  percent?: number;
  completedUnits?: number;
  totalUnits?: number;
  label?: string;
  artifactFingerprint?: string;
  failure?: LocalizeJobFailure;
}

export interface LocalizeCheckpointReadArgs {
  projectId: string;
  scope: 'translation' | 'voice' | 'cloud-recognition';
  key: string;
}

export interface LocalizeCheckpointWriteArgs extends LocalizeCheckpointReadArgs {
  value: unknown;
}

export const LOCALIZE_STAGE_WEIGHTS: Record<LocalizeJobStage, number> = {
  download: 8,
  recognition: 28,
  translation: 18,
  voice: 32,
  capcut: 14,
};

export function localizeJobOverallPercent(job: LocalizeJobManifest): number {
  const total = LOCALIZE_STAGE_ORDER.reduce((sum, stage) => (
    sum + LOCALIZE_STAGE_WEIGHTS[stage] * clampPercent(job.steps[stage]?.percent ?? 0) / 100
  ), 0);
  return Math.round(total);
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

