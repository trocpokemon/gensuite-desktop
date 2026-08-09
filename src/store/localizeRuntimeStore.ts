import { create } from 'zustand';
import type { PipelineProgressStep } from '../components/PipelineProgressPanel';
import type { PublicAppError } from '../shared/appErrors';
import {
  LOCALIZE_STAGE_ORDER,
  localizeJobOverallPercent,
  type LocalizeJobManifest,
  type LocalizeJobStage,
} from '../shared/localizeJob';

export type LocalizeRuntimeStage = LocalizeJobStage;
export type LocalizeRuntimeStatus = 'running' | 'blocked' | 'error' | 'cancelled' | 'completed';

export interface LocalizeFailureSnapshot {
  error: PublicAppError;
  occurredAt: string;
}

export interface LocalizeRuntimeJob {
  projectId: string;
  runId: string;
  status: LocalizeRuntimeStatus;
  stage: LocalizeRuntimeStage;
  steps: PipelineProgressStep[];
  lastActivityAt: number;
  errorMessage?: string;
  failure?: LocalizeFailureSnapshot;
  manifest?: LocalizeJobManifest;
}

interface LocalizeRuntimeState {
  jobs: Record<string, LocalizeRuntimeJob>;
  initialized: boolean;
  begin: (projectId: string, stage: LocalizeRuntimeStage, steps: PipelineProgressStep[]) => string;
  update: (projectId: string, runId: string, update: Partial<Omit<LocalizeRuntimeJob, 'projectId' | 'runId'>>) => void;
  acceptManifest: (manifest: LocalizeJobManifest) => void;
  initialize: () => Promise<void>;
  attach: (projectId: string) => Promise<LocalizeJobManifest | null>;
  remove: (projectId: string) => void;
}

const STAGE_LABELS: Record<LocalizeJobStage, string> = {
  download: 'Tải video',
  recognition: 'Nhận dạng',
  translation: 'Dịch',
  voice: 'Tạo voice',
  capcut: 'Dự án CapCut',
};

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function runtimeStatus(manifest: LocalizeJobManifest): LocalizeRuntimeStatus {
  if (manifest.status === 'failed') return 'error';
  if (manifest.status === 'queued') return 'running';
  return manifest.status;
}

function stepStatus(manifest: LocalizeJobManifest, stage: LocalizeJobStage): PipelineProgressStep['status'] {
  const status = manifest.steps[stage].status;
  if (status === 'completed') return 'completed';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed') return 'error';
  if (status === 'running' || status === 'preflight' || status === 'validating') return 'active';
  if (manifest.status === 'blocked' && manifest.activeStage === stage) return 'error';
  return 'pending';
}

function fromManifest(manifest: LocalizeJobManifest): LocalizeRuntimeJob {
  return {
    projectId: manifest.projectId,
    runId: manifest.operationId,
    status: runtimeStatus(manifest),
    stage: manifest.activeStage,
    steps: LOCALIZE_STAGE_ORDER.map((stage) => ({
      id: stage,
      label: STAGE_LABELS[stage],
      status: stepStatus(manifest, stage),
      percent: manifest.steps[stage].percent,
      detail: manifest.steps[stage].label,
    })),
    lastActivityAt: Date.parse(manifest.heartbeatAt) || Date.now(),
    failure: manifest.failure,
    manifest,
  };
}

let unsubscribeJobEvents: (() => void) | null = null;
let initialization: Promise<void> | null = null;

export const useLocalizeRuntimeStore = create<LocalizeRuntimeState>((set, get) => ({
  jobs: {},
  initialized: false,
  begin: (projectId, stage, steps) => {
    const runId = createRunId();
    set((state) => ({
      jobs: {
        ...state.jobs,
        [projectId]: { projectId, runId, status: 'running', stage, steps, lastActivityAt: Date.now() },
      },
    }));
    return runId;
  },
  update: (projectId, runId, update) => set((state) => {
    const current = state.jobs[projectId];
    if (!current || current.runId !== runId) return state;
    return { jobs: { ...state.jobs, [projectId]: { ...current, ...update } } };
  }),
  acceptManifest: (manifest) => set((state) => ({
    jobs: { ...state.jobs, [manifest.projectId]: fromManifest(manifest) },
  })),
  initialize: async () => {
    if (get().initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      if (!unsubscribeJobEvents) {
        unsubscribeJobEvents = window.gensuite.localize.onJob((manifest) => get().acceptManifest(manifest));
      }
      const result = await window.gensuite.localize.list();
      if (result.ok) {
        set((state) => ({
          jobs: result.value.reduce<Record<string, LocalizeRuntimeJob>>((jobs, manifest) => {
            jobs[manifest.projectId] = fromManifest(manifest);
            return jobs;
          }, { ...state.jobs }),
          initialized: true,
        }));
      } else {
        set({ initialized: true });
      }
    })().finally(() => { initialization = null; });
    return initialization;
  },
  attach: async (projectId) => {
    const result = await window.gensuite.localize.get(projectId);
    if (!result.ok || !result.value) return null;
    get().acceptManifest(result.value);
    return result.value;
  },
  remove: (projectId) => set((state) => {
    if (!state.jobs[projectId]) return state;
    const jobs = { ...state.jobs };
    delete jobs[projectId];
    return { jobs };
  }),
}));

export function localizeOverallPercent(job?: LocalizeRuntimeJob): number {
  if (!job) return 0;
  if (job.manifest) return localizeJobOverallPercent(job.manifest);
  return Math.round(job.steps.reduce((total, step) => total + Math.max(0, Math.min(100, step.percent)), 0) / Math.max(1, job.steps.length));
}
