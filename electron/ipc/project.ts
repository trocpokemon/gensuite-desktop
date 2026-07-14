import { app, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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

async function latestSceneFile(dir: string, sceneId: string): Promise<string | undefined> {
  const prefix = sanitize(sceneId);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter((entry) => entry.isFile() &&
    (entry.name.startsWith(`${prefix}.`) || entry.name.startsWith(`${prefix}-`)));
  const withStats = await Promise.all(candidates.map(async (entry) => ({
    path: path.join(dir, entry.name),
    mtimeMs: (await fs.stat(path.join(dir, entry.name))).mtimeMs,
  })));
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
    if (!(await exists(scene.audioPath))) {
      const recovered = await latestSceneFile(path.join(dir, 'audio'), scene.id);
      if (recovered) {
        next = { ...next, audioPath: recovered };
        changed = true;
      }
    }
    return next;
  }));
  return { project: changed ? { ...state, scenes } : state, changed };
}

async function readProject(id: string): Promise<ProjectState | null> {
  try {
    const raw = JSON.parse(await fs.readFile(projectFile(id), 'utf-8')) as ProjectState;
    const { project, changed } = await reconcileProjectFiles(raw);
    if (changed) await fs.writeFile(projectFile(id), JSON.stringify(project, null, 2), 'utf-8');
    return project;
  } catch {
    return null;
  }
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:save', async (_e, state: ProjectState): Promise<string> => {
    if (!state?.id) throw new Error('project state missing id');
    const dir = projectDir(state.id);
    await ensureDir(dir);
    const next = { ...state, updatedAt: new Date().toISOString() };
    await fs.writeFile(projectFile(state.id), JSON.stringify(next, null, 2), 'utf-8');
    await fs.writeFile(lastPointer(), JSON.stringify({ id: state.id }), 'utf-8');
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

  // Remove draft media/audio after a successful export to free disk space.
  ipcMain.handle('project:cleanup', async (_e, id: string): Promise<void> => {
    const dir = projectDir(id);
    for (const sub of ['media', 'audio']) {
      await fs.rm(path.join(dir, sub), { recursive: true, force: true }).catch(() => {});
    }
  });
}
