export type CapCutHostOs = 'windows' | 'mac';

type JsonRecord = Record<string, unknown>;

export interface CapCutCompatibilityProfile {
  version: string | number;
  newVersion: string;
  appVersion: string;
  platform: JsonRecord;
  lastModifiedPlatform: JsonRecord;
  markers: JsonRecord;
}

export interface CapCutRegistrationUpdate {
  draftId: string;
  draftName: string;
  durationUs: number;
  modifiedUs: number;
  timelineSize: number;
  draftJsonFile: string;
  draftPath: string;
  draftsDirectory: string;
}

/** Tested baseline used when a machine has no existing project to inspect. */
export function bundledCapCutCompatibilityProfile(expectedOs: CapCutHostOs): CapCutCompatibilityProfile | null {
  if (expectedOs !== 'windows') return null;
  return {
    version: 360000,
    newVersion: '179.0.0',
    appVersion: '9.1.0',
    platform: {
      os: 'windows',
      os_version: '10.0',
      app_id: '359289',
      app_version: '9.1.0',
      app_source: 'cc',
    },
    lastModifiedPlatform: {
      os: 'windows',
      os_version: '10.0',
      app_id: '359289',
      app_version: '9.1.0',
      app_source: 'cc',
    },
    markers: {
      draft_type: 'video',
      color_space: 0,
      free_render_index_mode_on: false,
      is_drop_frame_timecode: false,
      mixed_track_mode_on: false,
      render_index_track_mode_on: true,
    },
  };
}

const COMPATIBILITY_MARKERS = [
  'color_space',
  'draft_type',
  'free_render_index_mode_on',
  'is_drop_frame_timecode',
  'mixed_track_mode_on',
  'render_index_track_mode_on',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function safePlatform(value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const key of ['os', 'os_version', 'app_id', 'app_version', 'app_source']) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') result[key] = candidate;
  }
  return result;
}

function validSchemaVersion(value: unknown): value is string | number {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0)
    || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0);
}

export function readCapCutCompatibilityProfile(
  value: unknown,
  expectedOs: CapCutHostOs,
): CapCutCompatibilityProfile | null {
  if (!isRecord(value)
    || !validSchemaVersion(value.version)
    || typeof value.new_version !== 'string' || !value.new_version.trim()
    || !Array.isArray(value.tracks)
    || !isRecord(value.materials)
    || !isRecord(value.platform)
    || !isRecord(value.last_modified_platform)) return null;

  const platformOs = value.platform.os;
  const appSource = value.platform.app_source;
  const latestVersion = typeof value.last_modified_platform.app_version === 'string'
    ? value.last_modified_platform.app_version
    : value.platform.app_version;
  if (platformOs !== expectedOs || appSource !== 'cc' || typeof latestVersion !== 'string' || !latestVersion.trim()) {
    return null;
  }

  const markers: JsonRecord = {};
  for (const key of COMPATIBILITY_MARKERS) {
    if (value[key] !== undefined) markers[key] = value[key];
  }
  return {
    version: value.version,
    newVersion: value.new_version,
    appVersion: latestVersion,
    platform: safePlatform(value.platform),
    lastModifiedPlatform: safePlatform(value.last_modified_platform),
    markers,
  };
}

export function applyCapCutCompatibilityProfile(
  base: unknown,
  profile: CapCutCompatibilityProfile,
): JsonRecord {
  if (!isRecord(base) || !Array.isArray(base.tracks) || !isRecord(base.materials)) {
    throw new TypeError('invalid draft template');
  }
  const result = cloneRecord(base);
  result.version = profile.version;
  result.new_version = profile.newVersion;
  result.platform = cloneRecord(profile.platform);
  result.last_modified_platform = cloneRecord(profile.lastModifiedPlatform);
  for (const [key, value] of Object.entries(profile.markers)) result[key] = value;
  return result;
}

export function isCapCutDraftCompatible(
  value: unknown,
  profile: CapCutCompatibilityProfile,
): boolean {
  if (!isRecord(value)
    || value.version !== profile.version
    || value.new_version !== profile.newVersion
    || !Array.isArray(value.tracks)
    || value.tracks.length === 0
    || !isRecord(value.materials)
    || !isRecord(value.platform)
    || !isRecord(value.last_modified_platform)) return false;
  const latestVersion = typeof value.last_modified_platform.app_version === 'string'
    ? value.last_modified_platform.app_version
    : value.platform.app_version;
  return value.platform.os === profile.platform.os
    && value.platform.app_source === 'cc'
    && latestVersion === profile.appVersion;
}

export function updateCapCutRegistrationMetadata(
  value: unknown,
  update: CapCutRegistrationUpdate,
): { root: JsonRecord; entry: JsonRecord } | null {
  if (!isRecord(value)
    || !update.draftId
    || !update.draftName
    || !(update.durationUs > 0)
    || !(update.modifiedUs > 0)
    || !(update.timelineSize > 0)) return null;
  const root = cloneRecord(value);
  let entries: unknown[] | null = null;
  for (const [key, candidate] of Object.entries(root)) {
    if (!Array.isArray(candidate)) continue;
    if (/all_draft_store|draft_store/i.test(key)
      || candidate.some((item) => isRecord(item) && ('draft_fold_path' in item || 'draft_id' in item))) {
      entries = candidate;
      break;
    }
  }
  if (!entries) return null;
  const entry = entries.find((candidate) => isRecord(candidate) && candidate.draft_id === update.draftId);
  if (!isRecord(entry)) return null;
  entry.tm_duration = Math.round(update.durationUs);
  entry.tm_draft_modified = Math.round(update.modifiedUs);
  entry.draft_timeline_materials_size = Math.round(update.timelineSize);
  entry.draft_id = update.draftId;
  entry.draft_name = update.draftName;
  entry.draft_json_file = update.draftJsonFile;
  entry.draft_fold_path = update.draftPath;
  entry.draft_root_path = update.draftsDirectory;
  return { root, entry };
}
