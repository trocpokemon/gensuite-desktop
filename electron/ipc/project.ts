import { app, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectState } from '../../src/shared/types';

// Root: <userData>/GenSuite/projects/<id>/project.json
function projectsRoot(): string {
  return path.join(app.getPath('userData'), 'GenSuite', 'projects');
}

export function projectDir(id: string): string {
  return path.join(projectsRoot(), id);
}

function projectFile(id: string): string {
  return path.join(projectDir(id), 'project.json');
}

function projectBackupFile(id: string): string {
  return path.join(projectDir(id), 'project.backup.json');
}

const lastPointer = () => path.join(projectsRoot(), 'last.json');

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_');
}

async function exists(filePath?: string): Promise<boolean> {
  if (!filePath) return false;
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function writeJsonTransactional(filePath: string, value: unknown, backupPath?: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const partialPath = `${filePath}.${randomUUID()}.partial`;
  const displacedPath = `${filePath}.${randomUUID()}.previous`;
  const serialized = JSON.stringify(value, null, 2);
  await fs.writeFile(partialPath, serialized, { encoding: 'utf8', flag: 'wx' });
  JSON.parse(await fs.readFile(partialPath, 'utf8'));
  const existed = await exists(filePath);
  let displaced = false;
  try {
    if (existed) {
      if (backupPath) await fs.copyFile(filePath, backupPath);
      await fs.rename(filePath, displacedPath);
      displaced = true;
    }
    await fs.rename(partialPath, filePath);
    if (displaced) await fs.rm(displacedPath, { force: true });
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    if (displaced && !(await exists(filePath))) await fs.rename(displacedPath, filePath).catch(() => undefined);
    throw error;
  }
}

async function directorySize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return directorySize(entryPath);
    if (!entry.isFile()) return 0;
    return fs.stat(entryPath).then((stat) => stat.size).catch(() => 0);
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm']);

async function usableAudioCandidate(filePath?: string): Promise<boolean> {
  if (!filePath || !AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const fileName = path.basename(filePath).toLowerCase();
  if (['.partial.', '.part.', '.backup.', '.chunk-', '.concat.', '.parts.'].some((marker) => fileName.includes(marker))) return false;
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function latestSceneFile(dir: string, sceneId: string): Promise<string | undefined> {
  const prefix = sanitize(sceneId);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => entry.isFile() &&
    AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
    !['.partial.', '.part.', '.backup.', '.chunk-', '.concat.', '.parts.'].some((marker) => entry.name.toLowerCase().includes(marker)) &&
    (entry.name.startsWith(`${prefix}.`) || entry.name.startsWith(`${prefix}-`)));
  const withStats = (await Promise.all(candidates.map(async (entry) => {
    const candidatePath = path.join(dir, entry.name);
    const stat = await fs.stat(candidatePath).catch(() => null);
    return stat?.isFile() && stat.size > 0 ? { path: candidatePath, mtimeMs: stat.mtimeMs } : null;
  }))).filter((entry): entry is { path: string; mtimeMs: number } => Boolean(entry));
  return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

async function reconcileProjectFiles(state: ProjectState): Promise<{ project: ProjectState; changed: boolean }> {
  const dir = projectDir(state.id);
  let changed = false;
  const scenes = await Promise.all((state.scenes ?? []).map(async (scene) => {
    let next = scene;
    if (!(await exists(scene.imagePath))) {
      const recovered = await latestSceneFile(path.join(dir, 'media'), scene.id);
      if (recovered) {
        const ext = path.extname(recovered).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.mov', '.mkv'].includes(ext);
        next = { ...next, imagePath: recovered, visualType: isVideo ? 'stock-video' : 'stock-image' };
        changed = true;
      }
    }
    if (!(await usableAudioCandidate(scene.audioPath))) {
      const recovered = await latestSceneFile(path.join(dir, 'audio'), scene.id);
      if (recovered) {
        next = { ...next, audioPath: recovered };
        changed = true;
      } else if (scene.audioPath || scene.audioDuration) {
        next = { ...next, audioPath: undefined, audioDuration: undefined };
        changed = true;
      }
    }
    return next;
  }));
  return { project: changed ? { ...state, scenes } : state, changed };
}

async function readProject(id: string): Promise<ProjectState | null> {
  for (const candidate of [projectFile(id), projectBackupFile(id)]) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, 'utf-8')) as ProjectState;
      if (!raw?.id || raw.id !== id) continue;
      const { project, changed } = await reconcileProjectFiles(raw);
      if (changed) await writeJsonTransactional(projectFile(id), project, projectBackupFile(id));
      return project;
    } catch {
      // A validated backup keeps a project recoverable after an interrupted write.
    }
  }
  return null;
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:save', async (_e, state: ProjectState): Promise<string> => {
    if (!state?.id) throw new Error('project state missing id');
    const dir = projectDir(state.id);
    await ensureDir(dir);
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeJsonTransactional(projectFile(state.id), next, projectBackupFile(state.id));
    await writeJsonTransactional(lastPointer(), { id: state.id });
    return dir;
  });

  ipcMain.handle('project:load', async (_e, id: string): Promise<ProjectState | null> => {
    return readProject(id);
  });

  ipcMain.handle('project:loadLast', async (): Promise<ProjectState | null> => {
    try {
      const ptr = JSON.parse(await fs.readFile(lastPointer(), 'utf-8')) as { id?: string };
      if (!ptr.id) return null;
      return readProject(ptr.id);
    } catch {
      return null;
    }
  });

  ipcMain.handle('project:list', async (): Promise<ProjectState[]> => {
    try {
      const entries = await fs.readdir(projectsRoot(), { withFileTypes: true });
      const projects = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            try {
              return await readProject(entry.name);
            } catch {
              return null;
            }
          }),
      );
      return projects
        .filter((project): project is ProjectState => Boolean(project))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  });

  ipcMain.handle('project:remove', async (_e, id: string): Promise<void> => {
    if (!id) return;
    await fs.rm(projectDir(id), { recursive: true, force: true });
  });

  ipcMain.handle('project:dir', async (_e, id: string): Promise<string> => {
    const dir = projectDir(id);
    await ensureDir(dir);
    return dir;
  });

  ipcMain.handle('project:size', async (_e, id: string): Promise<number> => {
    if (!id) return 0;
    return directorySize(projectDir(id));
  });

  ipcMain.handle('project:openDir', async (_e, id: string): Promise<void> => {
    if (!id) return;
    const dir = projectDir(id);
    await ensureDir(dir);
    const error = await shell.openPath(dir);
    if (error) throw new Error('Không thể mở thư mục dự án.');
  });

  // Remove draft media/audio after a successful export to free disk space.
  ipcMain.handle('project:cleanup', async (_e, id: string): Promise<void> => {
    const dir = projectDir(id);
    for (const sub of ['media', 'audio']) {
      await fs.rm(path.join(dir, sub), { recursive: true, force: true }).catch(() => {});
    }
  });
}
