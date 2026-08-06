// Renderer-side helpers shared by the cloud voice adapters.

/** Measure an audio Blob's duration (seconds) via an offscreen <audio> element. */
export function measureDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    const cleanup = () => URL.revokeObjectURL(url);
    el.addEventListener('loadedmetadata', () => {
      const d = Number.isFinite(el.duration) ? el.duration : 0;
      cleanup();
      resolve(d);
    });
    el.addEventListener('error', () => {
      cleanup();
      resolve(0);
    });
    el.src = url;
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Persist a cloud adapter's audio Blob into the project dir via IPC and return
 * the on-disk path + measured duration — the shape every voice adapter returns,
 * so the timeline treats every engine identically.
 */
export async function persistCloudAudio(
  projectId: string,
  segmentId: string,
  blob: Blob,
  ext: 'mp3' | 'wav',
): Promise<{ audioPath: string; durationSec: number }> {
  const base64 = await blobToBase64(blob);
  const persisted = await window.gensuite.audio.write({ projectId, segmentId, base64, ext });
  if (!persisted.ok) throw persisted.error;
  const measured = await measureDuration(blob);
  return {
    audioPath: persisted.value.audioPath,
    durationSec: persisted.value.durationSec > 0 ? persisted.value.durationSec : measured,
  };
}

/** Revalidate a resumed scene before it is skipped or passed to video export. */
export async function probeUsableAudio(audioPath?: string): Promise<{ audioPath: string; durationSec: number } | null> {
  if (!audioPath) return null;
  try {
    const result = await window.gensuite.audio.probe({ audioPath });
    return result.ok && result.value.durationSec > 0 ? result.value : null;
  } catch {
    return null;
  }
}
