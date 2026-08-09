import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';

const requireNode = createRequire(import.meta.url);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gensuite-localize-job-'));

async function compile(fileName) {
  const filePath = path.resolve(fileName);
  return ts.transpileModule(await fs.readFile(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filePath,
  }).outputText;
}

function evaluate(source, dependencies = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)((name) => {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
    return requireNode(name);
  }, module, module.exports);
  return module.exports;
}

class TestAppFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const sharedErrors = evaluate(await compile('src/shared/appErrors.ts'));
const sharedJob = evaluate(await compile('src/shared/localizeJob.ts'), {
  './appErrors': sharedErrors,
});
const source = `${await compile('electron/ipc/localizeJob.ts')}
module.exports.__engineTest = { startJob, updateJob, cancelJob, readManifest, saveManifest, reconcileStale, manifestPath };
`;
const engineModule = evaluate(source, {
  electron: { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => undefined } },
  '../../src/shared/appErrors': sharedErrors,
  '../../src/shared/localizeJob': sharedJob,
  './appErrors': {
    appFailure: (code) => new TestAppFailure(code),
    appFailureResult: () => ({ ok: false }),
    appSuccess: (value) => ({ ok: true, value }),
  },
  './project': { projectDir: (projectId) => path.join(tempRoot, projectId) },
});
const engine = engineModule.__engineTest;
const fingerprint = 'a'.repeat(64);

try {
  const started = await engine.startJob({ projectId: 'restart-case', sourceFingerprint: fingerprint, configFingerprint: fingerprint });
  await engine.updateJob({
    projectId: started.projectId,
    operationId: started.operationId,
    stage: 'download',
    status: 'running',
    stageStatus: 'running',
    percent: 46,
  });
  const restored = await engine.readManifest(started.projectId);
  assert.equal(restored?.operationId, started.operationId, 'Restart must preserve operation ownership.');
  assert.equal(restored?.steps.download.percent, 46, 'Restart must preserve the latest stage progress.');

  await engine.updateJob({
    projectId: started.projectId,
    operationId: started.operationId,
    stage: 'download',
    status: 'running',
    stageStatus: 'completed',
    percent: 100,
  });
  await assert.rejects(() => engine.updateJob({
    projectId: started.projectId,
    operationId: started.operationId,
    stage: 'translation',
    status: 'running',
    stageStatus: 'running',
    percent: 1,
  }), (error) => error?.code === 'LOCALIZE_JOB_INPUT_INVALID', 'A later stage must not skip recognition.');

  const stale = await engine.readManifest(started.projectId);
  stale.heartbeatAt = new Date(Date.now() - 120_000).toISOString();
  await engine.saveManifest(stale);
  const blocked = await engine.reconcileStale(stale);
  assert.equal(blocked.status, 'blocked', 'An inactive job must become resumable instead of appearing to run forever.');

  const resumed = await engine.startJob({ projectId: started.projectId, sourceFingerprint: fingerprint, configFingerprint: fingerprint });
  assert.equal(resumed.operationId, started.operationId, 'A matching blocked job must resume the same operation.');
  assert.equal(resumed.status, 'running');

  await fs.writeFile(engine.manifestPath(started.projectId), '{broken', 'utf8');
  const backupRecovered = await engine.readManifest(started.projectId);
  assert.ok(backupRecovered, 'A corrupt primary manifest must fall back to its validated backup.');
  assert.equal(backupRecovered.projectId, started.projectId);

  const cancelled = await engine.cancelJob({ projectId: started.projectId, operationId: started.operationId });
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(() => engine.updateJob({
    projectId: started.projectId,
    operationId: started.operationId,
    stage: 'download',
    status: 'running',
    stageStatus: 'running',
    percent: 50,
  }), (error) => error?.code === 'LOCALIZE_JOB_OWNERSHIP_CONFLICT', 'Cancelled work must reject late progress events.');

  console.log('Behavior test localize job engine: passed (restart, stale recovery, backup, ordering, cancellation).');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
