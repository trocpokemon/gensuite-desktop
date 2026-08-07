export interface TextSegmentLike {
  text: string;
}

export interface RepetitionRun {
  startIndex: number;
  endIndex: number;
  length: number;
}

export function normalizeTranscriptText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function findConsecutiveRepetitionRuns(
  segments: TextSegmentLike[],
  minimumRun = 4,
): RepetitionRun[] {
  const normalized = segments.map((segment) => normalizeTranscriptText(segment.text));
  const runs: RepetitionRun[] = [];
  let start = 0;
  for (let index = 1; index <= normalized.length; index += 1) {
    const value = normalized[start] ?? '';
    const continues = index < normalized.length && value.length >= 2 && normalized[index] === value;
    if (continues) continue;
    const length = index - start;
    if (value.length >= 2 && length >= minimumRun) {
      runs.push({ startIndex: start, endIndex: index - 1, length });
    }
    start = index;
  }
  return runs;
}

export function transcriptHasAbnormalRepetition(segments: TextSegmentLike[]): boolean {
  if (segments.length < 4) return false;
  if (findConsecutiveRepetitionRuns(segments).length) return true;

  const normalized = segments.map((segment) => normalizeTranscriptText(segment.text));
  for (let start = 0; start + 7 < normalized.length; start += 1) {
    const window = normalized.slice(start, start + 10).filter((value) => value.length >= 2);
    const counts = new Map<string, number>();
    for (const value of window) counts.set(value, (counts.get(value) ?? 0) + 1);
    if (Math.max(0, ...counts.values()) >= 6) return true;
  }
  return false;
}
