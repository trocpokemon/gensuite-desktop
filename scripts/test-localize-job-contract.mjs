import assert from 'node:assert/strict';
import {
  LOCALIZE_JOB_SCHEMA_VERSION,
  LOCALIZE_STAGE_ORDER,
  clampPercent,
  localizeJobOverallPercent,
} from '../src/shared/localizeJob.ts';

const now = new Date().toISOString();
const steps = Object.fromEntries(LOCALIZE_STAGE_ORDER.map((stage) => [stage, {
  stage,
  status: 'pending',
  percent: 0,
}]));
const manifest = {
  schemaVersion: LOCALIZE_JOB_SCHEMA_VERSION,
  projectId: 'behavior-test',
  operationId: 'operation-test',
  status: 'running',
  activeStage: 'download',
  createdAt: now,
  updatedAt: now,
  heartbeatAt: now,
  steps,
};

assert.equal(clampPercent(Number.NaN), 0);
assert.equal(clampPercent(-12), 0);
assert.equal(clampPercent(120), 100);
assert.equal(localizeJobOverallPercent(manifest), 0);

manifest.steps.download.percent = 100;
manifest.steps.download.status = 'completed';
assert.equal(localizeJobOverallPercent(manifest), 8, 'download weight must be reflected exactly');

manifest.steps.recognition.percent = 50;
manifest.steps.recognition.status = 'running';
assert.equal(localizeJobOverallPercent(manifest), 22, 'partial recognition must add weighted progress');

for (const stage of LOCALIZE_STAGE_ORDER) {
  manifest.steps[stage].percent = 100;
  manifest.steps[stage].status = 'completed';
}
assert.equal(localizeJobOverallPercent(manifest), 100);
assert.deepEqual(LOCALIZE_STAGE_ORDER, ['download', 'recognition', 'translation', 'voice', 'capcut']);

console.log('Behavior test localize job contract: passed.');
