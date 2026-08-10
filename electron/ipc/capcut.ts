import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CapCutDraftExportArgs, CapCutDraftExportResult, CapCutExportPreflightArgs, CapCutExportPreflightResult, SourceVideoValidationResult } from '../../src/shared/types';
import type { AppErrorCode, AppErrorContext } from '../../src/shared/appErrors';
import { buildCapCutDraftSpec, safeCapCutProjectName, synchronizeCapCutCaptionSemantics, synchronizeCapCutVoiceTiming, type CapCutCompileSpec } from '../../src/shared/capcutDraft';
import {
  applyCapCutCompatibilityProfile,
  bundledCapCutCompatibilityProfile,
  isCapCutDraftCompatible,
  readCapCutCompatibilityProfile,
  updateCapCutRegistrationMetadata,
  type CapCutCompatibilityProfile,
  type CapCutHostOs,
} from '../../src/shared/capcutDraftCompatibility';
import { appFailure, appFailureResult, appSuccess, AppFailure } from './appErrors';
import { ffprobeBinary } from './ffmpeg';

const require = createRequire(import.meta.url);
const MAX_SEGMENTS = 1_500;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const INACTIVITY_TIMEOUT_MS = 3 * 60_000;
const HARD_TIMEOUT_MS = 30 * 60_000;

type ChildOutcome = {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
};

type RootMetaSnapshot = {
  rootMetaPath: string;
  existed: boolean;
  backupPath?: string;
};

type CompatibilityTemplate = {
  directory: string;
  fileName: 'draft_content.json' | 'draft_info.json';
  profile: CapCutCompatibilityProfile;
};

type CachedCompatibilityProfile = Omit<CompatibilityTemplate, 'directory'> & {
  schemaVersion: 1;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function systemCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code.toUpperCase() : undefined;
}

function draftDirectoryCandidates(): string[] {
  const override = process.env.CAPCUT_DRAFT_DIR?.trim();
  const candidates = override ? [override] : [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
  }
  return candidates.map((candidate) => path.resolve(candidate));
}

function expandedDraftDirectoryCandidates(selected: string): string[] {
  const root = path.resolve(selected);
  return [
    root,
    path.join(root, 'com.lveditor.draft'),
    path.join(root, 'Projects', 'com.lveditor.draft'),
    path.join(root, 'User Data', 'Projects', 'com.lveditor.draft'),
  ];
}

function selectedDraftDirectoryCandidates(selected: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(selected);
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(...expandedDraftDirectoryCandidates(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(candidates)];
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveDraftsDirectory(selected?: string): Promise<string> {
  const candidates = selected?.trim()
    ? [...selectedDraftDirectoryCandidates(selected.trim()), ...draftDirectoryCandidates()]
    : draftDirectoryCandidates();
  for (const candidate of candidates) {
    if (path.basename(candidate).toLowerCase() !== 'com.lveditor.draft') continue;
    if (await isDirectory(candidate)) {
      await fs.access(candidate, fsConstants.R_OK | fsConstants.W_OK);
      return path.resolve(candidate);
    }
  }
  throw appFailure('CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE', undefined, { operation: 'draft-directory' });
}

function validateExportArgs(value: unknown): asserts value is CapCutDraftExportArgs {
  if (!isRecord(value)
    || typeof value.projectId !== 'string' || !value.projectId.trim()
    || typeof value.projectName !== 'string'
    || (value.sourceDurationSec !== undefined
      && (typeof value.sourceDurationSec !== 'number' || !Number.isFinite(value.sourceDurationSec) || value.sourceDurationSec <= 0))
    || !Array.isArray(value.segments) || value.segments.length === 0
    || typeof value.subtitles !== 'boolean'
    || (value.captionLanguage !== undefined && (typeof value.captionLanguage !== 'string' || value.captionLanguage.length > 32))
    || typeof value.originalAudioVolume !== 'number' || !Number.isFinite(value.originalAudioVolume)
    || (value.musicPath !== undefined && (typeof value.musicPath !== 'string' || !path.isAbsolute(value.musicPath)))
    || (value.draftsDirectory !== undefined && (typeof value.draftsDirectory !== 'string' || !path.isAbsolute(value.draftsDirectory)))
    || (value.templateDraftDirectory !== undefined && (typeof value.templateDraftDirectory !== 'string' || !path.isAbsolute(value.templateDraftDirectory)))
    || (value.manualOutputDirectory !== undefined && (typeof value.manualOutputDirectory !== 'string' || !path.isAbsolute(value.manualOutputDirectory)))) {
    throw appFailure('CAPCUT_EXPORT_INPUT_INVALID', undefined, { operation: 'draft-validate' });
  }
  if (typeof value.sourceVideoPath !== 'string' || !path.isAbsolute(value.sourceVideoPath)) {
    throw appFailure('CAPCUT_SOURCE_UNAVAILABLE', undefined, { operation: 'draft-validate', classifier: 'source-path' });
  }
  const segments = value.segments as unknown[];
  if (segments.length > MAX_SEGMENTS) {
    throw appFailure('CAPCUT_SEGMENT_LIMIT', undefined, { operation: 'draft-validate', segmentCount: segments.length });
  }
  segments.forEach((segment, index) => {
    const context = { segmentNumber: index + 1, segmentCount: segments.length };
    if (!isRecord(segment)) {
      throw appFailure('CAPCUT_TIMELINE_INVALID', context, { operation: 'draft-validate', classifier: 'segment-shape' });
    }
    if (typeof segment.audioPath !== 'string' || !path.isAbsolute(segment.audioPath)) {
      throw appFailure('CAPCUT_VOICE_UNAVAILABLE', context, { operation: 'draft-validate', classifier: 'voice-path' });
    }
    if (typeof segment.sourceStart !== 'number' || !Number.isFinite(segment.sourceStart) || segment.sourceStart < 0
      || typeof segment.sourceEnd !== 'number' || !Number.isFinite(segment.sourceEnd) || segment.sourceEnd <= segment.sourceStart
      || typeof segment.text !== 'string') {
      throw appFailure('CAPCUT_TIMELINE_INVALID', context, { operation: 'draft-validate', classifier: 'segment-timing' });
    }
    if (typeof segment.audioDuration !== 'number' || !Number.isFinite(segment.audioDuration) || segment.audioDuration <= 0) {
      throw appFailure('CAPCUT_VOICE_UNREADABLE', context, { operation: 'draft-validate', classifier: 'voice-duration' });
    }
  });
}

async function assertReadableFile(
  input: string,
  unavailableCode: AppErrorCode,
  unreadableCode: AppErrorCode,
  context: AppErrorContext | undefined,
  classifier: string,
): Promise<void> {
  try {
    const stat = await fs.stat(input);
    if (!stat.isFile() || stat.size <= 0) {
      throw appFailure(unreadableCode, context, { operation: 'draft-inputs', classifier });
    }
    await fs.access(input, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    const code = systemCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      throw appFailure('CAPCUT_EXPORT_PERMISSION_DENIED', context, { operation: 'draft-inputs', classifier, systemCode: code });
    }
    throw appFailure(code === 'ENOENT' ? unavailableCode : unreadableCode, context, {
      operation: 'draft-inputs', classifier, systemCode: code,
    });
  }
}

async function assertReadableInputs(args: CapCutDraftExportArgs): Promise<void> {
  await assertReadableFile(args.sourceVideoPath, 'CAPCUT_SOURCE_UNAVAILABLE', 'CAPCUT_SOURCE_UNREADABLE', undefined, 'source-file');
  for (let index = 0; index < args.segments.length; index += 1) {
    await assertReadableFile(
      args.segments[index].audioPath,
      'CAPCUT_VOICE_UNAVAILABLE',
      'CAPCUT_VOICE_UNREADABLE',
      { segmentNumber: index + 1, segmentCount: args.segments.length },
      'voice-file',
    );
  }
  if (args.musicPath) {
    await assertReadableFile(args.musicPath, 'BACKGROUND_AUDIO_UNAVAILABLE', 'BACKGROUND_AUDIO_UNREADABLE', undefined, 'background-file');
  }
}

async function editorIsRunning(): Promise<boolean> {
  const executable = process.platform === 'win32' ? 'tasklist' : 'ps';
  const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-axo', 'comm='];
  return await new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 5_000);
    child.stdout?.on('data', (chunk) => {
      if (output.length < 256 * 1024) output += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output.toLowerCase().includes(process.platform === 'win32' ? 'capcut.exe' : 'capcut'));
    });
  });
}

async function capCutExecutableCandidates(): Promise<string[]> {
  if (process.platform === 'darwin') {
    return [
      '/Applications/CapCut.app',
      path.join(os.homedir(), 'Applications', 'CapCut.app'),
    ];
  }
  if (process.platform !== 'win32') return [];

  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value));
  const appsRoot = path.join(local, 'CapCut', 'Apps');
  const candidates = [
    path.join(appsRoot, 'CapCut.exe'),
    path.join(local, 'Programs', 'CapCut', 'CapCut.exe'),
    ...programFiles.map((root) => path.join(root, 'CapCut', 'CapCut.exe')),
  ];

  try {
    const versionDirectories = await fs.readdir(appsRoot, { withFileTypes: true });
    const versionCandidates = await Promise.all(versionDirectories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const executable = path.join(appsRoot, entry.name, 'CapCut.exe');
        const stat = await fs.stat(executable).catch(() => null);
        return stat?.isFile() ? { executable, modifiedAt: stat.mtimeMs } : null;
      }));
    candidates.push(...versionCandidates
      .filter((entry): entry is { executable: string; modifiedAt: number } => Boolean(entry))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((entry) => entry.executable));
  } catch {
    // Other well-known installation locations are still checked below.
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function launchCapCut(): Promise<boolean> {
  const candidates = await capCutExecutableCandidates();
  let installationFound = false;
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (!stat || (!stat.isFile() && !stat.isDirectory())) continue;
    installationFound = true;
    const launchError = await shell.openPath(candidate);
    if (!launchError) return true;
  }
  if (installationFound) {
    throw appFailure('CAPCUT_APP_LAUNCH_FAILED', undefined, {
      operation: 'editor-launch', classifier: 'launch-failed',
    });
  }
  throw appFailure('CAPCUT_APP_UNAVAILABLE', undefined, {
    operation: 'editor-launch', classifier: 'app-not-found',
  });
}

async function probeSourceVideo(
  sourceVideoPath: string,
  failureCode: AppErrorCode = 'CAPCUT_SOURCE_UNREADABLE',
  operation = 'draft-probe',
): Promise<SourceVideoValidationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(ffprobeBinary(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', sourceVideoPath,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const stream = parsed.streams?.[0];
        const durationSec = Number(parsed.format?.duration);
        if (code !== 0 || !stream?.width || !stream.height || !(durationSec > 0)) throw new Error('invalid media');
        resolve({ width: stream.width, height: stream.height, durationSec });
      } catch {
        reject(appFailure(failureCode, undefined, { operation, classifier: 'source-media' }));
      }
    });
  });
}

async function validateSourceVideo(sourceVideoPath: string): Promise<SourceVideoValidationResult> {
  if (!sourceVideoPath || !path.isAbsolute(sourceVideoPath)) {
    throw appFailure('VIDEO_SOURCE_UNAVAILABLE', undefined, { operation: 'source-preflight', classifier: 'source-path' });
  }
  try {
    const stat = await fs.stat(sourceVideoPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw appFailure('VIDEO_SOURCE_UNREADABLE', undefined, { operation: 'source-preflight', classifier: 'source-file' });
    }
    await fs.access(sourceVideoPath, fsConstants.R_OK);
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    const code = systemCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      throw appFailure('VIDEO_SOURCE_PERMISSION_DENIED', undefined, { operation: 'source-preflight', classifier: 'source-file', systemCode: code });
    }
    throw appFailure(code === 'ENOENT' ? 'VIDEO_SOURCE_UNAVAILABLE' : 'VIDEO_SOURCE_UNREADABLE', undefined, {
      operation: 'source-preflight', classifier: 'source-file', systemCode: code,
    });
  }
  return probeSourceVideo(sourceVideoPath, 'VIDEO_SOURCE_UNREADABLE', 'source-preflight');
}

function packageCliPath(): string {
  try {
    const manifest = require.resolve('capcut-cli/package.json');
    return path.join(path.dirname(manifest), 'dist', 'index.js');
  } catch {
    throw appFailure('CAPCUT_EXPORT_COMPONENT_UNAVAILABLE', undefined, { operation: 'draft-component' });
  }
}

function hostOs(): CapCutHostOs | null {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return null;
}

async function discoverCompatibilityProfile(
  draftsDirectory: string,
): Promise<Omit<CompatibilityTemplate, 'directory'>> {
  const expectedOs = hostOs();
  if (!expectedOs) {
    throw appFailure('CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', undefined, { operation: 'draft-compatibility' });
  }
  let directories;
  try {
    directories = (await fs.readdir(draftsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
  } catch (error) {
    const cached = await loadCompatibilityProfile(expectedOs);
    if (cached) return cached;
    const bundled = bundledCapCutCompatibilityProfile(expectedOs);
    if (bundled) return { fileName: 'draft_content.json', profile: bundled };
    throw appFailure('CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', undefined, {
      operation: 'draft-compatibility',
      systemCode: systemCode(error),
    });
  }
  const ranked = await Promise.all(directories.map(async (entry) => {
    const directory = path.join(draftsDirectory, entry.name);
    const modified = await fs.stat(directory).then((stat) => stat.mtimeMs).catch(() => 0);
    return { directory, modified, generated: entry.name.startsWith('GenSuite -') };
  }));
  ranked.sort((left, right) => Number(left.generated) - Number(right.generated) || right.modified - left.modified);
  const fileNames: CompatibilityTemplate['fileName'][] = expectedOs === 'windows'
    ? ['draft_content.json']
    : ['draft_info.json', 'draft_content.json'];
  for (const candidate of ranked.slice(0, 100)) {
    for (const fileName of fileNames) {
      const filePath = path.join(candidate.directory, fileName);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size <= 100 || stat.size > MAX_TEMPLATE_BYTES) continue;
        const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const profile = readCapCutCompatibilityProfile(parsed, expectedOs);
        if (profile) {
          const discovered = { fileName, profile };
          await saveCompatibilityProfile(discovered).catch(() => undefined);
          return discovered;
        }
      } catch {
        // Ignore unreadable, stale or incompatible projects and inspect the next one.
      }
    }
  }
  const cached = await loadCompatibilityProfile(expectedOs);
  if (cached) return cached;
  const bundled = bundledCapCutCompatibilityProfile(expectedOs);
  if (bundled) return { fileName: 'draft_content.json', profile: bundled };
  throw appFailure('CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', undefined, {
    operation: 'draft-compatibility',
    classifier: 'profile-missing',
  });
}

async function preflightExport(args: CapCutExportPreflightArgs): Promise<CapCutExportPreflightResult> {
  const portable = Boolean(args.manualOutputDirectory?.trim());
  const outputDirectory = portable
    ? await resolvePortableOutputDirectory(args.manualOutputDirectory as string)
    : await resolveDraftsDirectory(args.draftsDirectory);
  await resolveCompatibility(outputDirectory, args.templateDraftDirectory);
  if (!portable) {
    const rootMetaPath = path.join(outputDirectory, 'root_meta_info.json');
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(rootMetaPath, 'utf8'));
      if (!isRecord(parsed)) throw new TypeError('invalid project index');
    } catch {
      throw appFailure('CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE', undefined, {
        operation: 'draft-preflight', classifier: 'project-index-missing',
      });
    }
  }
  return {
    mode: portable ? 'portable' : 'registered',
    compatibility: args.templateDraftDirectory?.trim() ? 'selected-project' : 'automatic',
  };
}

async function compatibilityFromSelectedProject(
  selectedDirectory: string,
): Promise<Omit<CompatibilityTemplate, 'directory'>> {
  const expectedOs = hostOs();
  if (!expectedOs || !path.isAbsolute(selectedDirectory)) {
    throw appFailure('CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', undefined, {
      operation: 'draft-compatibility', classifier: 'selected-project-invalid',
    });
  }
  const fileNames: CompatibilityTemplate['fileName'][] = expectedOs === 'windows'
    ? ['draft_content.json']
    : ['draft_info.json', 'draft_content.json'];
  for (const fileName of fileNames) {
    try {
      const filePath = path.join(selectedDirectory, fileName);
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size <= 100 || stat.size > MAX_TEMPLATE_BYTES) continue;
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const profile = readCapCutCompatibilityProfile(parsed, expectedOs);
      if (profile) return { fileName, profile };
    } catch {
      // Try the other supported timeline file before returning a public error.
    }
  }
  throw appFailure('CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', undefined, {
    operation: 'draft-compatibility', classifier: 'selected-project-invalid',
  });
}

async function resolvePortableOutputDirectory(selected: string): Promise<string> {
  const directory = path.resolve(selected);
  if (!path.isAbsolute(selected) || !(await isDirectory(directory))) {
    throw appFailure('CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE', undefined, {
      operation: 'portable-directory', classifier: 'directory-missing',
    });
  }
  try {
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
    return directory;
  } catch {
    throw appFailure('CAPCUT_EXPORT_PERMISSION_DENIED', undefined, {
      operation: 'portable-directory', classifier: 'permission',
    });
  }
}

async function resolveCompatibility(
  draftsDirectory: string,
  templateDraftDirectory?: string,
): Promise<Omit<CompatibilityTemplate, 'directory'>> {
  return templateDraftDirectory?.trim()
    ? compatibilityFromSelectedProject(templateDraftDirectory.trim())
    : discoverCompatibilityProfile(draftsDirectory);
}

function compatibilityProfilePath(expectedOs: CapCutHostOs): string {
  return path.join(app.getPath('userData'), 'GenSuite', 'runtime', `capcut-compatibility-${expectedOs}.json`);
}

async function loadCompatibilityProfile(expectedOs: CapCutHostOs): Promise<Omit<CompatibilityTemplate, 'directory'> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(compatibilityProfilePath(expectedOs), 'utf8')) as CachedCompatibilityProfile;
    if (parsed.schemaVersion !== 1 || !['draft_content.json', 'draft_info.json'].includes(parsed.fileName)) return null;
    const verified = readCapCutCompatibilityProfile(applyCapCutCompatibilityProfile({
      version: parsed.profile.version,
      new_version: parsed.profile.newVersion,
      tracks: [],
      materials: {},
      platform: parsed.profile.platform,
      last_modified_platform: parsed.profile.lastModifiedPlatform,
      ...parsed.profile.markers,
    }, parsed.profile), expectedOs);
    return verified ? { fileName: parsed.fileName, profile: verified } : null;
  } catch {
    return null;
  }
}

async function saveCompatibilityProfile(value: Omit<CompatibilityTemplate, 'directory'>): Promise<void> {
  const expectedOs = hostOs();
  if (!expectedOs) return;
  const filePath = compatibilityProfilePath(expectedOs);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextTransactional(filePath, JSON.stringify({ schemaVersion: 1, ...value } satisfies CachedCompatibilityProfile));
}

async function createCompatibilityTemplate(
  cliPath: string,
  draftsDirectory: string,
  tempDirectory: string,
  templateDraftDirectory?: string,
): Promise<CompatibilityTemplate> {
  const discovered = await resolveCompatibility(draftsDirectory, templateDraftDirectory);
  const bundledTemplatePath = path.join(
    path.dirname(path.dirname(cliPath)),
    'templates',
    '_init',
    'draft_content.json',
  );
  let base: unknown;
  try {
    base = JSON.parse(await fs.readFile(bundledTemplatePath, 'utf8'));
  } catch {
    throw appFailure('CAPCUT_EXPORT_COMPONENT_UNAVAILABLE', undefined, { operation: 'draft-component' });
  }
  const compatible = applyCapCutCompatibilityProfile(base, discovered.profile);
  const directory = path.join(tempDirectory, 'compatible-template');
  await fs.mkdir(directory, { recursive: false });
  await fs.writeFile(path.join(directory, discovered.fileName), JSON.stringify(compatible), {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { ...discovered, directory };
}

async function activityToken(directory: string): Promise<string> {
  let totalSize = 0;
  let newest = 0;
  const queue: Array<{ directory: string; depth: number }> = [{ directory, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 3) queue.push({ directory: fullPath, depth: current.depth + 1 });
      else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          totalSize += stat.size;
          newest = Math.max(newest, stat.mtimeMs);
        } catch {
          // A file can be replaced between listing and stat while the writer is active.
        }
      }
    }
  }
  return `${totalSize}:${Math.round(newest)}`;
}

async function directorySize(directory: string): Promise<number> {
  let totalSize = 0;
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) totalSize += (await fs.stat(fullPath)).size;
    }
  }
  return totalSize;
}

async function runCompiler(
  cliPath: string,
  specPath: string,
  outputPath: string,
  checkOnly: boolean,
  templateDirectory?: string,
): Promise<ChildOutcome> {
  const commandArgs = [cliPath, 'compile', specPath, '--out', outputPath, '--json', '--quiet'];
  if (templateDirectory) commandArgs.push('--template', templateDirectory);
  if (checkOnly) commandArgs.push('--check');
  const child = spawn(process.execPath, commandArgs, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: `${path.dirname(ffprobeBinary())}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  let stderr = '';
  let timedOut = false;
  let lastActivity = Date.now();
  let previousToken = '';
  const touch = () => { lastActivity = Date.now(); };
  child.stdout?.on('data', touch);
  child.stderr?.on('data', (chunk) => {
    touch();
    if (stderr.length < MAX_CAPTURE_BYTES) stderr += String(chunk).slice(0, MAX_CAPTURE_BYTES - stderr.length);
  });

  const watchdog = setInterval(() => {
    void activityToken(outputPath).then((token) => {
      if (token !== previousToken) {
        previousToken = token;
        touch();
      }
      if (!timedOut && Date.now() - lastActivity > (checkOnly ? 60_000 : INACTIVITY_TIMEOUT_MS)) {
        timedOut = true;
        child.kill();
      }
    });
  }, 3_000);
  const hardTimeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, checkOnly ? 90_000 : HARD_TIMEOUT_MS);

  return await new Promise((resolve, reject) => {
    child.on('error', (error) => {
      clearInterval(watchdog);
      clearTimeout(hardTimeout);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearInterval(watchdog);
      clearTimeout(hardTimeout);
      resolve({ exitCode, stderr, timedOut });
    });
  });
}

function compilerFailure(outcome: ChildOutcome): AppFailure {
  if (outcome.timedOut) return appFailure('CAPCUT_EXPORT_TIMEOUT', undefined, { operation: 'draft-compile' });
  const normalized = outcome.stderr.toLowerCase();
  if (normalized.includes('is running') || normalized.includes('close the editor')) {
    return appFailure('CAPCUT_EDITOR_BUSY', undefined, { operation: 'draft-compile', classifier: 'editor-busy' });
  }
  if (normalized.includes('enospc') || normalized.includes('no space')) {
    return appFailure('CAPCUT_EXPORT_STORAGE_FULL', undefined, { operation: 'draft-compile', classifier: 'storage-full' });
  }
  if (normalized.includes('eacces') || normalized.includes('eperm') || normalized.includes('permission denied')) {
    return appFailure('CAPCUT_EXPORT_PERMISSION_DENIED', undefined, { operation: 'draft-compile', classifier: 'permission' });
  }
  return appFailure('CAPCUT_EXPORT_FAILED', undefined, {
    operation: 'draft-compile',
    classifier: 'writer-failed',
    exitCode: outcome.exitCode ?? undefined,
  });
}

async function snapshotRootMeta(draftsDirectory: string): Promise<RootMetaSnapshot> {
  const rootMetaPath = path.join(draftsDirectory, 'root_meta_info.json');
  const existed = await fs.access(rootMetaPath).then(() => true).catch(() => false);
  if (!existed) return { rootMetaPath, existed: false };
  const backupPath = `${rootMetaPath}.gensuite-${randomUUID()}.bak`;
  await fs.copyFile(rootMetaPath, backupPath, fsConstants.COPYFILE_EXCL);
  return { rootMetaPath, existed: true, backupPath };
}

async function replaceFileFromBackup(targetPath: string, backupPath: string): Promise<void> {
  const partialPath = `${targetPath}.gensuite-${randomUUID()}.partial`;
  const displacedPath = `${targetPath}.gensuite-${randomUUID()}.failed`;
  await fs.copyFile(backupPath, partialPath, fsConstants.COPYFILE_EXCL);
  let displaced = false;
  try {
    if (await fs.access(targetPath).then(() => true).catch(() => false)) {
      await fs.rename(targetPath, displacedPath);
      displaced = true;
    }
    await fs.rename(partialPath, targetPath);
    if (displaced) await fs.rm(displacedPath, { force: true });
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    if (displaced && !(await fs.access(targetPath).then(() => true).catch(() => false))) {
      await fs.rename(displacedPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function writeTextTransactional(targetPath: string, content: string): Promise<void> {
  const partialPath = `${targetPath}.gensuite-${randomUUID()}.partial`;
  const displacedPath = `${targetPath}.gensuite-${randomUUID()}.previous`;
  await fs.writeFile(partialPath, content, { encoding: 'utf8', flag: 'wx' });
  const existed = await fs.access(targetPath).then(() => true).catch(() => false);
  let displaced = false;
  try {
    if (existed) {
      await fs.rename(targetPath, displacedPath);
      displaced = true;
    }
    await fs.rename(partialPath, targetPath);
    if (displaced) await fs.rm(displacedPath, { force: true });
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    if (displaced && !(await fs.access(targetPath).then(() => true).catch(() => false))) {
      await fs.rename(displacedPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function syncDraftRegistration(
  draftsDirectory: string,
  draftPath: string,
  timelineFileName: CompatibilityTemplate['fileName'],
  timeline: Record<string, unknown>,
): Promise<void> {
  const draftId = typeof timeline.id === 'string' ? timeline.id : '';
  const duration = typeof timeline.duration === 'number' && Number.isFinite(timeline.duration)
    ? Math.max(0, Math.round(timeline.duration))
    : 0;
  if (!draftId || duration <= 0) {
    throw appFailure('CAPCUT_EXPORT_COMPATIBILITY_FAILED', undefined, {
      operation: 'draft-registration',
      classifier: 'timeline-metadata',
    });
  }
  const rootMetaPath = path.join(draftsDirectory, 'root_meta_info.json');
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(rootMetaPath, 'utf8'));
    if (!isRecord(parsed)) throw new TypeError('invalid root metadata');
    root = parsed;
  } catch {
    throw appFailure('CAPCUT_EXPORT_COMPATIBILITY_FAILED', undefined, {
      operation: 'draft-registration',
      classifier: 'root-metadata',
    });
  }
  const updated = updateCapCutRegistrationMetadata(root, {
    draftId,
    draftName: typeof timeline.name === 'string' && timeline.name.trim()
      ? timeline.name
      : path.basename(draftPath),
    durationUs: duration,
    modifiedUs: Date.now() * 1000,
    timelineSize: await directorySize(draftPath),
    draftJsonFile: path.join(draftPath, timelineFileName),
    draftPath,
    draftsDirectory,
  });
  if (!updated) {
    throw appFailure('CAPCUT_EXPORT_COMPATIBILITY_FAILED', undefined, {
      operation: 'draft-registration',
      classifier: 'registration-missing',
    });
  }
  await writeTextTransactional(rootMetaPath, JSON.stringify(updated.root));
  await writeTextTransactional(path.join(draftPath, 'draft_meta_info.json'), JSON.stringify(updated.entry));
}

async function verifyCompatibleDraft(
  draftPath: string,
  compatibility: CompatibilityTemplate,
): Promise<Record<string, unknown>> {
  const timelinePath = path.join(draftPath, compatibility.fileName);
  try {
    const stat = await fs.stat(timelinePath);
    if (!stat.isFile() || stat.size <= 100) throw new TypeError('empty timeline');
    const parsed: unknown = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
    if (!isCapCutDraftCompatible(parsed, compatibility.profile) || !isRecord(parsed)) {
      throw new TypeError('incompatible timeline');
    }
    const unwantedMirror = compatibility.fileName === 'draft_content.json'
      ? path.join(draftPath, 'draft_info.json')
      : path.join(draftPath, 'draft_content.json');
    await fs.rm(unwantedMirror, { force: true });
    return parsed;
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw appFailure('CAPCUT_EXPORT_COMPATIBILITY_FAILED', undefined, {
      operation: 'draft-verify',
      classifier: 'schema-mismatch',
    });
  }
}

async function synchronizeVoiceTiming(
  draftPath: string,
  timelineFileName: CompatibilityTemplate['fileName'],
  spec: CapCutCompileSpec,
): Promise<void> {
  const timelinePath = path.join(draftPath, timelineFileName);
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
    if (!isRecord(parsed)) throw new TypeError('invalid timeline');
    const synchronized = synchronizeCapCutCaptionSemantics(
      synchronizeCapCutVoiceTiming(parsed, spec),
      spec,
    );
    await writeTextTransactional(timelinePath, JSON.stringify(synchronized));
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw appFailure('CAPCUT_EXPORT_COMPATIBILITY_FAILED', undefined, {
      operation: 'draft-voice-timing',
      systemCode: systemCode(error),
    });
  }
}

function assertDirectChild(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('unsafe recovery target');
  }
}

async function recoverFailedExport(
  draftsDirectory: string,
  draftPath: string,
  snapshot: RootMetaSnapshot,
): Promise<void> {
  assertDirectChild(draftsDirectory, draftPath);
  await fs.rm(draftPath, { recursive: true, force: true });
  if (snapshot.existed && snapshot.backupPath) {
    await replaceFileFromBackup(snapshot.rootMetaPath, snapshot.backupPath);
    await fs.rm(snapshot.backupPath, { force: true });
  } else {
    await fs.rm(snapshot.rootMetaPath, { force: true });
  }
}

function datedProjectName(projectName: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${safeCapCutProjectName(projectName).slice(0, 54)} - ${stamp}`;
}

async function uniqueDraftPath(draftsDirectory: string, projectName: string): Promise<{ draftPath: string; projectName: string }> {
  const baseName = datedProjectName(projectName);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix ? `${baseName} (${suffix + 1})` : baseName;
    const candidate = path.join(draftsDirectory, name);
    if (!(await fs.access(candidate).then(() => true).catch(() => false))) return { draftPath: candidate, projectName: name };
  }
  throw appFailure('CAPCUT_EXPORT_FAILED', undefined, { operation: 'draft-name' });
}

async function exportDraft(args: CapCutDraftExportArgs): Promise<CapCutDraftExportResult> {
  validateExportArgs(args);
  await assertReadableInputs(args);
  const portable = Boolean(args.manualOutputDirectory?.trim());
  const draftsDirectory = portable
    ? await resolvePortableOutputDirectory(args.manualOutputDirectory as string)
    : await resolveDraftsDirectory(args.draftsDirectory);
  if (!portable && await editorIsRunning()) {
    throw appFailure('CAPCUT_EDITOR_BUSY', undefined, { operation: 'draft-editor-check' });
  }
  const source = await probeSourceVideo(args.sourceVideoPath);
  const normalizedArgs: CapCutDraftExportArgs = { ...args, sourceDurationSec: source.durationSec };
  const destination = await uniqueDraftPath(draftsDirectory, args.projectName);
  const spec = buildCapCutDraftSpec(normalizedArgs, {
    projectName: destination.projectName,
    width: source.width,
    height: source.height,
  });
  const cliPath = packageCliPath();
  const tempDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'gensuite-draft-'));
  const specPath = path.join(tempDirectory, 'project.json');
  await fs.writeFile(specPath, JSON.stringify(spec), { encoding: 'utf8', flag: 'wx' });

  let snapshot: RootMetaSnapshot | undefined;
  try {
    const compatibility = await createCompatibilityTemplate(cliPath, draftsDirectory, tempDirectory, args.templateDraftDirectory);
    const check = await runCompiler(cliPath, specPath, destination.draftPath, true);
    if (check.exitCode !== 0) throw compilerFailure(check);
    if (!portable) snapshot = await snapshotRootMeta(draftsDirectory);
    const outcome = await runCompiler(
      cliPath,
      specPath,
      destination.draftPath,
      false,
      compatibility.directory,
    );
    if (outcome.exitCode !== 0) throw compilerFailure(outcome);
    await synchronizeVoiceTiming(destination.draftPath, compatibility.fileName, spec);
    const timeline = await verifyCompatibleDraft(destination.draftPath, compatibility);
    if (!portable) {
      await syncDraftRegistration(
        draftsDirectory,
        destination.draftPath,
        compatibility.fileName,
        timeline,
      );
    }
    if (snapshot?.backupPath) await fs.rm(snapshot.backupPath, { force: true }).catch(() => undefined);
    return { draftPath: destination.draftPath, projectName: destination.projectName, registered: !portable };
  } catch (error) {
    if (snapshot) {
      try {
        await recoverFailedExport(draftsDirectory, destination.draftPath, snapshot);
      } catch {
        throw appFailure('CAPCUT_EXPORT_RECOVERY_FAILED', undefined, { operation: 'draft-recovery' });
      }
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerCapCutDraftIpc(): void {
  ipcMain.handle('capcut:launch', async () => {
    try {
      return appSuccess(await launchCapCut());
    } catch (error) {
      return appFailureResult<boolean>(error, 'CAPCUT_APP_LAUNCH_FAILED', {
        operation: 'editor-launch',
      });
    }
  });

  ipcMain.handle('capcut:exportDraft', async (_event, args: unknown) => {
    try {
      validateExportArgs(args);
      return appSuccess(await exportDraft(args));
    } catch (error) {
      return appFailureResult<CapCutDraftExportResult>(error, 'CAPCUT_EXPORT_FAILED', {
        operation: 'draft-export',
        segmentCount: isRecord(args) && Array.isArray(args.segments) ? args.segments.length : undefined,
      });
    }
  });

  ipcMain.handle('capcut:preflight', async (_event, args: unknown) => {
    try {
      if (!isRecord(args)
        || (args.draftsDirectory !== undefined && (typeof args.draftsDirectory !== 'string' || !path.isAbsolute(args.draftsDirectory)))
        || (args.templateDraftDirectory !== undefined && (typeof args.templateDraftDirectory !== 'string' || !path.isAbsolute(args.templateDraftDirectory)))
        || (args.manualOutputDirectory !== undefined && (typeof args.manualOutputDirectory !== 'string' || !path.isAbsolute(args.manualOutputDirectory)))) {
        throw appFailure('CAPCUT_EXPORT_INPUT_INVALID', undefined, { operation: 'draft-preflight' });
      }
      return appSuccess(await preflightExport(args));
    } catch (error) {
      return appFailureResult<CapCutExportPreflightResult>(error, 'CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', {
        operation: 'draft-preflight',
      });
    }
  });

  ipcMain.handle('capcut:validateSource', async (_event, sourceVideoPath: unknown) => {
    try {
      if (typeof sourceVideoPath !== 'string') throw appFailure('VIDEO_SOURCE_UNAVAILABLE');
      return appSuccess(await validateSourceVideo(sourceVideoPath));
    } catch (error) {
      return appFailureResult<SourceVideoValidationResult>(error, 'VIDEO_SOURCE_UNREADABLE', {
        operation: 'source-preflight',
      });
    }
  });

  ipcMain.handle('capcut:selectDraftsDirectory', async (event) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const defaultCandidates = draftDirectoryCandidates();
      const defaultPath = (await Promise.all(defaultCandidates.map(async (candidate) => (
        await isDirectory(candidate) ? candidate : null
      )))).find((candidate): candidate is string => Boolean(candidate));
      const options = {
        title: 'Chọn thư mục dự án CapCut',
        defaultPath: defaultPath ?? app.getPath('documents'),
        properties: ['openDirectory'] as Array<'openDirectory'>,
      };
      const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return appSuccess<string | null>(null);
      return appSuccess<string | null>(await resolveDraftsDirectory(selection.filePaths[0]));
    } catch (error) {
      return appFailureResult<string | null>(error, 'CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE', {
        operation: 'draft-directory-select',
      });
    }
  });

  ipcMain.handle('capcut:selectTemplateDraftDirectory', async (event) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = {
        title: 'Chọn dự án mẫu CapCut',
        defaultPath: (await resolveDraftsDirectory().catch(() => app.getPath('documents'))),
        properties: ['openDirectory'] as Array<'openDirectory'>,
      };
      const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return appSuccess<string | null>(null);
      await compatibilityFromSelectedProject(selection.filePaths[0]);
      return appSuccess<string | null>(path.resolve(selection.filePaths[0]));
    } catch (error) {
      return appFailureResult<string | null>(error, 'CAPCUT_COMPATIBILITY_TEMPLATE_UNAVAILABLE', {
        operation: 'draft-template-select',
      });
    }
  });

  ipcMain.handle('capcut:selectManualOutputDirectory', async (event) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = {
        title: 'Chọn thư mục xuất dự án',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      };
      const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (selection.canceled || !selection.filePaths[0]) return appSuccess<string | null>(null);
      return appSuccess<string | null>(await resolvePortableOutputDirectory(selection.filePaths[0]));
    } catch (error) {
      return appFailureResult<string | null>(error, 'CAPCUT_DRAFT_DIRECTORY_UNAVAILABLE', {
        operation: 'portable-directory-select',
      });
    }
  });
}
