function versionParts(value: string): number[] {
  return value.trim().replace(/^v/i, '').split('-', 1)[0].split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const next = candidateParts[index] ?? 0;
    const installed = currentParts[index] ?? 0;
    if (next !== installed) return next > installed;
  }
  return false;
}
