export interface SrtEntry {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
}

const TIMECODE_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})(?:\s+.*)?$/;

function timecodeToSeconds(parts: RegExpMatchArray, offset: number): number {
  const hours = Number(parts[offset]);
  const minutes = Number(parts[offset + 1]);
  const seconds = Number(parts[offset + 2]);
  const milliseconds = Number(parts[offset + 3].padEnd(3, '0').slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/** Parse valid SubRip cues and retain their original timeline. */
export function parseSrt(raw: string): SrtEntry[] {
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];

  const entries: SrtEntry[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.trim().split('\n');
    const timingIndex = lines.findIndex((line) => TIMECODE_RE.test(line.trim()));
    if (timingIndex < 0 || timingIndex >= lines.length - 1) continue;
    const timing = lines[timingIndex].trim().match(TIMECODE_RE);
    if (!timing) continue;
    const startTime = timecodeToSeconds(timing, 1);
    const endTime = timecodeToSeconds(timing, 5);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) continue;
    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) continue;
    const parsedId = Number.parseInt(lines[0]?.trim() || '', 10);
    entries.push({ id: Number.isFinite(parsedId) ? parsedId : entries.length + 1, startTime, endTime, text });
  }
  return entries.sort((left, right) => left.startTime - right.startTime || left.id - right.id);
}

export function formatSrtPreviewTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function toSrtTimecode(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(milliseconds, 3)}`;
}

/** Rebuild provider-ready SubRip content from the validated cue list. */
export function buildSrtContent(entries: SrtEntry[]): string {
  return `${entries.map((entry, index) => (
    `${index + 1}\n${toSrtTimecode(entry.startTime)} --> ${toSrtTimecode(entry.endTime)}\n${entry.text}`
  )).join('\n\n')}\n`;
}
