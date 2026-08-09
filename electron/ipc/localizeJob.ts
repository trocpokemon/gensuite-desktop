import { BrowserWindow, ipcMain } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcResult } from '../../src/shared/appErrors';
import { isPublicAppError } from '../../src/shared/appErrors';
import {
  LOCALIZE_JOB_SCHEMA_VERSION,
  LOCALIZE_STAGE_ORDER,
  clampPercent,
  type LocalizeCheckpointReadArgs,
  type LocalizeCheckpointWriteArgs,
  type LocalizeJobIdentity,
  type LocalizeJobManifest,
  type LocalizeJobStage,
  type LocalizeJobStartArgs,
  type LocalizeJobUpdateArgs,
  type LocalizeStageProgress,
} from '../../src/shared/localizeJob';
import { appFailure, appFailureResult, appSuccess } from './appErrors';
import { projectDir } from './project';

const STALE_HEARTBEAT_MS = 90_000;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const jobLocks = new Map<string, Promise<void>>();
const JOB_STATUSES = new Set(['queued', 'running', 'blocked', 'failed', 'cancelled', 'completed']);
const STAGE_STATUSES = new Set(['pending', 'preflight', 'running', 'validating', 'completed', 'failed', 'skipped']);

function runtimeDir(projectId: string): string {
  return path.join(projectDir(projectId), 'runtime');
}

function manifestPath(projectId: string): string {
  return path.join(runtimeDir(projectId), 'localize-job.json');
}

function backupManifestPath(projectId: string): string {
  return path.join(runtimeDir(projectId), 'localize-job.backup.json');
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function validStage(value: unknown): value is LocalizeJobStage {
  return typeof value === 'string' && LOCALIZE_STAGE_ORDER.includes(value as LocalizeJobStage);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validFingerprint(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
}

function emptySteps(): Record<LocalizeJobStage, LocalizeStageProgress> {
  return Object.fromEntries(LOCALIZE_STAGE_ORDER.map((stage) => [stage, {
    stage,
    status: 'pending',
    percent: 0,
  }])) as Record<LocalizeJobStage, LocalizeStageProgress>;
}

function isManifest(value: unknown): value is LocalizeJobManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== LOCALIZE_JOB_SCHEMA_VERSION || !validId(record.projectId)
    || !validId(record.operationId) || !validStage(record.activeStage)
    || !JOB_STATUSES.has(String(record.status))
    || !validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt) || !validTimestamp(record.heartbeatAt)
    || !validFingerprint(record.sourceFingerprint) || !validFingerprint(record.configFingerprint)
    || (record.failure !== undefined && (!record.failure || typeof record.failure !== 'object'
      || !isPublicAppError((record.failure as Record<string, unknown>).error)
      || !validTimestamp((record.failure as Record<string, unknown>).occurredAt)))
    || !record.steps || typeof record.steps !== 'object') return false;
  const steps = record.steps as Record<string, unknown>;
  return LOCALIZE_STAGE_ORDER.every((stage) => {
    const step = steps[stage];
    return Boolean(step && typeof step === 'object'
      && (step as Record<string, unknown>).stage === stage
      && STAGE_STATUSES.has(String((step as Record<string, unknown>).status))
      && typeof (step as Record<string, unknown>).percent === 'number'
      && Number.isFinite((step as Record<string, unknown>).percent)
      && Number((step as Record<string, unknown>).percent) >= 0
      && Number((step as Record<string, unknown>).percent) <= 100);
  });
}

async function atomicJsonWrite(filePath: string, value: unknown, backupPath?: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const partial = `${filePath}.${randomUUID()}.partial`;
  const displaced = `${filePath}.${randomUUID()}.previous`;
  const serialized = JSON.stringify(value, null, 2);
  await fs.writeFile(partial, serialized, { encoding: 'utf8', flag: 'wx' });
  try {
    JSON.parse(await fs.readFile(partial, 'utf8'));
    const existed = await fs.access(filePath).then(() => true).catch(() => false);
    if (existed && backupPath) await fs.copyFile(filePath, backupPath);
    if (existed) await fs.rename(filePath, displaced);
    await fs.rename(partial, filePath);
    if (existed) await fs.rm(displaced, { force: true });
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    const targetMissing = await fs.access(filePath).then(() => false).catch(() => true);
    if (targetMissing) await fs.rename(displaced, filePath).catch(() => undefined);
    throw error;
  }
}

async function readManifest(projectId: string): Promise<LocalizeJobManifest | null> {
  for (const candidate of [manifestPath(projectId), backupManifestPath(projectId)]) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (isManifest(parsed) && parsed.projectId === projectId) return parsed;
    } catch {
      // Try the validated backup. A corrupt control file must not erase work.
    }
  }
  return null;
}

async function saveManifest(manifest: LocalizeJobManifest): Promise<void> {
  await atomicJsonWrite(manifestPath(manifest.projectId), manifest, backupManifestPath(manifest.projectId));
}

async function serializeProjectUpdate<T>(projectId: string, update: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  jobLocks.set(projectId, queued);
  await previous;
  try {
    return await update();
  } finally {
    release();
    if (jobLocks.get(projectId) === queued) jobLocks.delete(projectId);
  }
}

function emitJob(manifest: LocalizeJobManifest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('localize:job-event', manifest);
  }
}

function newManifest(args: LocalizeJobStartArgs): LocalizeJobManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: LOCALIZE_JOB_SCHEMA_VERSION,
    projectId: args.projectId,
    operationId: randomUUID(),
    status: 'running',
    activeStage: 'download',
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    sourceFingerprint: args.sourceFingerprint,
    configFingerprint: args.configFingerprint,
    steps: emptySteps(),
  };
}

async function startJob(args: LocalizeJobStartArgs): Promise<LocalizeJobManifest> {
  if (!validId(args?.projectId) || !validFingerprint(args.sourceFingerprint) || !validFingerprint(args.configFingerprint)
    || (args.restart !== undefined && typeof args.restart !== 'boolean')) throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
  return serializeProjectUpdate(args.projectId, async () => {
    const existing = await readManifest(args.projectId);
    const fingerprintsMatch = existing
      && (!args.sourceFingerprint || !existing.sourceFingerprint || args.sourceFingerprint === existing.sourceFingerprint)
      && (!args.configFingerprint || !existing.configFingerprint || args.configFingerprint === existing.configFingerprint);
    if (existing && !args.restart && fingerprintsMatch && existing.status !== 'completed' && existing.status !== 'cancelled') {
      const now = new Date().toISOString();
      const resumed: LocalizeJobManifest = {
        ...existing,
        status: 'running',
        updatedAt: now,
        heartbeatAt: now,
        cancellationRequested: false,
        failure: undefined,
      };
      await saveManifest(resumed);
      emitJob(resumed);
      return resumed;
    }
    const created = newManifest(args);
    await saveManifest(created);
    emitJob(created);
    return created;
  });
}

async function updateJob(args: LocalizeJobUpdateArgs): Promise<LocalizeJobManifest> {
  if (!validId(args?.projectId) || !validId(args.operationId) || !validStage(args.stage)
    || (args.status !== undefined && !JOB_STATUSES.has(args.status))
    || (args.stageStatus !== undefined && !STAGE_STATUSES.has(args.stageStatus))
    || (args.percent !== undefined && !Number.isFinite(args.percent))
    || (args.completedUnits !== undefined && (!Number.isInteger(args.completedUnits) || args.completedUnits < 0))
    || (args.totalUnits !== undefined && (!Number.isInteger(args.totalUnits) || args.totalUnits < 0))
    || (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 160))
    || !validFingerprint(args.artifactFingerprint)) {
    throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
  }
  return serializeProjectUpdate(args.projectId, async () => {
    const current = await readManifest(args.projectId);
    if (!current) throw appFailure('LOCALIZE_JOB_NOT_FOUND');
    if (current.operationId !== args.operationId) throw appFailure('LOCALIZE_JOB_OWNERSHIP_CONFLICT');
    if (current.status === 'cancelled' || current.cancellationRequested) throw appFailure('LOCALIZE_JOB_OWNERSHIP_CONFLICT');
    const now = new Date().toISOString();
    const previous = current.steps[args.stage];
    const requestedPercent = args.percent === undefined ? previous.percent : clampPercent(args.percent);
    const percent = args.stageStatus === 'running' && previous.status === 'failed'
      ? requestedPercent
      : Math.max(previous.percent, requestedPercent);
    const stageStatus = args.stageStatus ?? previous.status;
    const earlierStages = LOCALIZE_STAGE_ORDER.slice(0, LOCALIZE_STAGE_ORDER.indexOf(args.stage));
    if (stageStatus !== 'pending' && earlierStages.some((stage) => !['completed', 'skipped'].includes(current.steps[stage].status))) {
      throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
    }
    if (previous.status === 'completed' && stageStatus !== 'completed') throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
    const nextStep: LocalizeStageProgress = {
      ...previous,
      status: stageStatus,
      percent: stageStatus === 'completed' ? 100 : percent,
      completedUnits: args.completedUnits ?? previous.completedUnits,
      totalUnits: args.totalUnits ?? previous.totalUnits,
      label: args.label ?? previous.label,
      artifactFingerprint: args.artifactFingerprint ?? previous.artifactFingerprint,
      diagnosticId: args.failure?.error.diagnosticId ?? previous.diagnosticId,
      startedAt: previous.startedAt ?? (stageStatus !== 'pending' ? now : undefined),
      completedAt: stageStatus === 'completed' ? now : previous.completedAt,
      lastActivityAt: now,
    };
    const status = args.failure ? 'failed' : (args.status ?? current.status);
    const nextSteps = { ...current.steps, [args.stage]: nextStep };
    if (status === 'completed' && LOCALIZE_STAGE_ORDER.some((stage) => !['completed', 'skipped'].includes(nextSteps[stage].status))) {
      throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
    }
    const next: LocalizeJobManifest = {
      ...current,
      status,
      activeStage: args.stage,
      updatedAt: now,
      heartbeatAt: now,
      steps: nextSteps,
      failure: args.failure ?? (status === 'running' ? undefined : current.failure),
    };
    await saveManifest(next);
    emitJob(next);
    return next;
  });
}

async function cancelJob(identity: LocalizeJobIdentity): Promise<LocalizeJobManifest> {
  if (!validId(identity?.projectId) || !validId(identity.operationId)) {
    throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
  }
  return serializeProjectUpdate(identity.projectId, async () => {
    const current = await readManifest(identity.projectId);
    if (!current) throw appFailure('LOCALIZE_JOB_NOT_FOUND');
    if (current.operationId !== identity.operationId) throw appFailure('LOCALIZE_JOB_OWNERSHIP_CONFLICT');
    const now = new Date().toISOString();
    const next = { ...current, status: 'cancelled' as const, cancellationRequested: true, updatedAt: now, heartbeatAt: now };
    await saveManifest(next);
    emitJob(next);
    return next;
  });
}

async function reconcileStale(manifest: LocalizeJobManifest): Promise<LocalizeJobManifest> {
  if (manifest.status !== 'running' || Date.now() - Date.parse(manifest.heartbeatAt) <= STALE_HEARTBEAT_MS) return manifest;
  const now = new Date().toISOString();
  const next: LocalizeJobManifest = {
    ...manifest,
    status: 'blocked',
    updatedAt: now,
    steps: {
      ...manifest.steps,
      [manifest.activeStage]: {
        ...manifest.steps[manifest.activeStage],
        label: 'Có thể tiếp tục từ phần đã lưu',
      },
    },
  };
  await saveManifest(next);
  emitJob(next);
  return next;
}

function checkpointPath(args: LocalizeCheckpointReadArgs): string {
  if (!validId(args.projectId) || !['translation', 'voice', 'cloud-recognition'].includes(args.scope)
    || typeof args.key !== 'string' || !args.key || args.key.length > 512) {
    throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
  }
  const digest = createHash('sha256').update(args.key).digest('hex');
  return path.join(runtimeDir(args.projectId), 'checkpoints', args.scope, `${digest}.json`);
}

async function readCheckpoint(args: LocalizeCheckpointReadArgs): Promise<unknown | null> {
  const filePath = checkpointPath(args);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) return null;
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function writeCheckpoint(args: LocalizeCheckpointWriteArgs): Promise<boolean> {
  const filePath = checkpointPath(args);
  const serialized = JSON.stringify(args.value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw appFailure('LOCALIZE_CHECKPOINT_INVALID');
  }
  await atomicJsonWrite(filePath, args.value);
  return true;
}

async function removeCheckpoint(args: LocalizeCheckpointReadArgs): Promise<boolean> {
  await fs.rm(checkpointPath(args), { force: true });
  return true;
}

export function registerLocalizeJobIpc(): void {
  ipcMain.handle('localize:start', async (_event, args: LocalizeJobStartArgs): Promise<IpcResult<LocalizeJobManifest>> => {
    try { return appSuccess(await startJob(args)); }
    catch (error) { return appFailureResult(error, 'LOCALIZE_JOB_UNEXPECTED', { operation: 'localize-start' }); }
  });
  ipcMain.handle('localize:update', async (_event, args: LocalizeJobUpdateArgs): Promise<IpcResult<LocalizeJobManifest>> => {
    try {
      if (args?.failure && !isPublicAppError(args.failure.error)) throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
      return appSuccess(await updateJob(args));
    } catch (error) { return appFailureResult(error, 'LOCALIZE_JOB_UNEXPECTED', { operation: 'localize-update' }); }
  });
  ipcMain.handle('localize:get', async (_event, projectId: string): Promise<IpcResult<LocalizeJobManifest | null>> => {
    try {
      if (!validId(projectId)) throw appFailure('LOCALIZE_JOB_INPUT_INVALID');
      const manifest = await readManifest(projectId);
      return appSuccess(manifest ? await reconcileStale(manifest) : null);
    } catch (error) { return appFailureResult(error, 'LOCALIZE_JOB_UNEXPECTED', { operation: 'localize-get' }); }
  });
  ipcMain.handle('localize:list', async (): Promise<IpcResult<LocalizeJobManifest[]>> => {
    try {
      const root = path.dirname(projectDir('_'));
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      const manifests = await Promise.all(entries.filter((entry) => entry.isDirectory() && validId(entry.name)).map(async (entry) => {
        const manifest = await readManifest(entry.name);
        return manifest ? reconcileStale(manifest) : null;
      }));
      return appSuccess(manifests.filter((item): item is LocalizeJobManifest => Boolean(item)));
    } catch (error) { return appFailureResult(error, 'LOCALIZE_JOB_UNEXPECTED', { operation: 'localize-list' }); }
  });
  ipcMain.handle('localize:cancel', async (_event, identity: LocalizeJobIdentity): Promise<IpcResult<LocalizeJobManifest>> => {
    try { return appSuccess(await cancelJob(identity)); }
    catch (error) { return appFailureResult(error, 'LOCALIZE_JOB_UNEXPECTED', { operation: 'localize-cancel' }); }
  });
  ipcMain.handle('localize:checkpoint-read', async (_event, args: LocalizeCheckpointReadArgs): Promise<IpcResult<unknown | null>> => {
    try { return appSuccess(await readCheckpoint(args)); }
    catch (error) { return appFailureResult(error, 'LOCALIZE_CHECKPOINT_UNAVAILABLE', { operation: 'checkpoint-read' }); }
  });
  ipcMain.handle('localize:checkpoint-write', async (_event, args: LocalizeCheckpointWriteArgs): Promise<IpcResult<boolean>> => {
    try { return appSuccess(await writeCheckpoint(args)); }
    catch (error) { return appFailureResult(error, 'LOCALIZE_CHECKPOINT_UNAVAILABLE', { operation: 'checkpoint-write' }); }
  });
  ipcMain.handle('localize:checkpoint-remove', async (_event, args: LocalizeCheckpointReadArgs): Promise<IpcResult<boolean>> => {
    try { return appSuccess(await removeCheckpoint(args)); }
    catch (error) { return appFailureResult(error, 'LOCALIZE_CHECKPOINT_UNAVAILABLE', { operation: 'checkpoint-remove' }); }
  });
}
