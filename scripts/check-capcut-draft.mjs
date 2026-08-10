import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function loadTypeScriptModule(fileName) {
  const filePath = path.resolve(fileName);
  const sourceText = await readFile(filePath, 'utf8');
  const output = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    (name) => { throw new Error(`Unexpected runtime dependency: ${name}`); },
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const file = path.resolve('src/shared/capcutDraft.ts');
const ipcSource = await readFile(path.resolve('electron/ipc/capcut.ts'), 'utf8');
const studioSource = await readFile(path.resolve('src/steps/NarrationStudio.tsx'), 'utf8');
const localizeStudioSource = await readFile(path.resolve('src/steps/LocalizeStudio.tsx'), 'utf8');
const preloadSource = await readFile(path.resolve('electron/preload.ts'), 'utf8');
const projectIpcSource = await readFile(path.resolve('electron/ipc/project.ts'), 'utf8');
const { buildCapCutDraftSpec, safeCapCutProjectName, synchronizeCapCutCaptionSemantics, synchronizeCapCutVoiceTiming } = await loadTypeScriptModule(file);
const {
  applyCapCutCompatibilityProfile,
  bundledCapCutCompatibilityProfile,
  isCapCutDraftCompatible,
  readCapCutCompatibilityProfile,
  updateCapCutRegistrationMetadata,
} = await loadTypeScriptModule('src/shared/capcutDraftCompatibility.ts');

const subtitleConfig = {
  fontSizePct: 4.2,
  textColor: '#ffffff',
  outlineColor: '#101010',
  outlineWidth: 1.4,
  shadowDepth: 2,
  backgroundStyle: 'rounded',
  backgroundColor: '#101828',
  backgroundOpacity: 82,
  backgroundRadius: 12,
  xPct: 50,
  yPct: 88,
};
const spec = buildCapCutDraftSpec({
  projectId: 'project-1',
  projectName: 'Video: thử / bản 1',
  sourceVideoPath: 'C:\\media\\source.mp4',
  sourceDurationSec: 120,
  segments: [
    { audioPath: 'C:\\media\\voice-2.mp3', sourceStart: 12, sourceEnd: 16, text: 'Câu thứ hai', audioDuration: 8 },
    { audioPath: 'C:\\media\\voice-1.mp3', sourceStart: 2, sourceEnd: 5.5, text: 'Câu thứ nhất', audioDuration: 3 },
  ],
  subtitles: true,
  subtitleConfig,
  originalAudioVolume: 8,
  musicPath: 'C:\\media\\music.mp3',
  musicVolume: 18,
}, { projectName: 'GenSuite - Video thử', width: 1080, height: 1920, fps: 30 });

assert.equal(spec.name, 'GenSuite - Video thử');
assert.deepEqual([spec.width, spec.height, spec.fps, spec.ratio], [1080, 1920, 30, 'original']);
assert.deepEqual(spec.tracks.map((track) => track.name), ['Video gốc', 'Giọng thuyết minh', 'Nhạc nền', 'Phụ đề']);
assert.equal(spec.tracks[0].items[0].duration, 120);
assert.equal(spec.tracks[0].items[0].volume, 0.08);
assert.deepEqual(spec.tracks[1].items.map((item) => item.start), [2, 12]);
assert.deepEqual(spec.tracks[1].items.map((item) => item.duration), [3, 4]);
assert.deepEqual(spec.tracks[1].items.map((item) => item.speed), [1, 2]);
assert.ok(spec.tracks[1].items.every((item, index, items) => (
  index === items.length - 1 || item.start + item.duration <= items[index + 1].start
)), 'Voice clips must never overlap the next source window.');
const voiceItems = spec.tracks[1].items;
const draftVoiceSegments = voiceItems.map((item, index) => ({
  material_id: `audio-${index}`,
  target_timerange: { start: Math.round(item.start * 1_000_000), duration: Math.round(item.duration * 1_000_000) },
  source_timerange: { start: 0, duration: Math.round(item.duration * 1_000_000) },
  speed: 1,
  extra_material_refs: [`speed-${index}`],
}));
const synchronizedTimeline = synchronizeCapCutVoiceTiming({
  tracks: [{ type: 'audio', name: 'Giọng thuyết minh', segments: draftVoiceSegments }],
  materials: {
    audios: voiceItems.map((_, index) => ({ id: `audio-${index}`, duration: 1 })),
    speeds: voiceItems.map((_, index) => ({ id: `speed-${index}`, speed: 1 })),
  },
}, spec);
assert.equal(draftVoiceSegments[1].target_timerange.duration, 4_000_000);
assert.equal(draftVoiceSegments[1].source_timerange.duration, 8_000_000);
assert.equal(draftVoiceSegments[1].speed, 2);
assert.equal(synchronizedTimeline.materials.audios[1].duration, 8_000_000);
assert.equal(synchronizedTimeline.materials.speeds[1].speed, 2);
assert.equal(spec.tracks[2].items[0].volume, 0.18);
assert.deepEqual(spec.tracks[3].items.map((item) => item.text), ['Câu thứ nhất', 'Câu thứ hai']);
assert.equal(spec.tracks[3].items[0].y, -0.76);
assert.equal(spec.operations?.length, 2);
assert.equal(spec.operations?.[0].style.bgAlpha, 0.82);
const plainCaptionSpec = buildCapCutDraftSpec({
  projectId: 'plain-captions',
  projectName: 'Phụ đề thuần',
  sourceVideoPath: 'C:\\media\\source.mp4',
  sourceDurationSec: 20,
  segments: [
    { audioPath: 'C:\\media\\voice-1.mp3', sourceStart: 1, sourceEnd: 4, text: 'Phụ đề có thể chỉnh trong CapCut', audioDuration: 2 },
  ],
  subtitles: true,
  captionLanguage: 'english',
  originalAudioVolume: 0,
});
assert.deepEqual(plainCaptionSpec.tracks.map((track) => track.name), ['Video gốc', 'Giọng thuyết minh', 'Phụ đề']);
assert.equal(plainCaptionSpec.tracks[2].items[0].text, 'Phụ đề có thể chỉnh trong CapCut');
assert.equal(plainCaptionSpec.tracks[2].items[0].start, 1);
assert.equal(plainCaptionSpec.tracks[2].items[0].duration, 3);
assert.equal(plainCaptionSpec.operations, undefined, 'Plain captions must not carry GenSuite styling.');
const nativeCaptionSegment = { id: 'caption-segment-1', material_id: 'caption-1', extra_material_refs: [], track_attribute: 2 };
const nativeCaptionTimeline = synchronizeCapCutCaptionSemantics({
  tracks: [{ id: 'caption-track', type: 'text', name: 'Phụ đề', flag: 0, attribute: 2, is_default_name: false, segments: [nativeCaptionSegment] }],
  materials: { texts: [{ id: 'caption-1', type: 'text', sub_type: 1, add_type: 0, initial_scale: 0, content: '{"text":"Phụ đề có thể chỉnh trong CapCut","styles":[]}' }], material_animations: [] },
  config: { subtitle_recognition_id: '', subtitle_sync: false, subtitle_taskinfo: [] },
  function_assistant_info: { auto_caption: false, auto_caption_segid_list: [], auto_caption_template_id: '' },
}, plainCaptionSpec);
assert.equal(nativeCaptionTimeline.tracks[0].name, '');
assert.equal(nativeCaptionTimeline.tracks[0].flag, 1);
assert.equal(nativeCaptionTimeline.tracks[0].attribute, 0);
assert.equal(nativeCaptionTimeline.tracks[0].is_default_name, true);
assert.equal(nativeCaptionTimeline.materials.texts[0].type, 'subtitle');
assert.equal(nativeCaptionTimeline.materials.texts[0].sub_type, 0);
assert.equal(nativeCaptionTimeline.materials.texts[0].add_type, 1);
assert.equal(nativeCaptionTimeline.materials.texts[0].initial_scale, 1);
assert.equal(nativeCaptionTimeline.materials.texts[0].layer_weight, 1);
assert.equal(nativeCaptionTimeline.materials.texts[0].language, 'en-US');
assert.match(nativeCaptionTimeline.materials.texts[0].group_id, /^en-US_\d{13}$/);
assert.match(nativeCaptionTimeline.materials.texts[0].recognize_task_id, /^[0-9a-f]{24}_8_0$/);
assert.equal(nativeCaptionTimeline.materials.texts[0].base_content, nativeCaptionTimeline.materials.texts[0].content);
assert.equal(nativeCaptionTimeline.materials.texts[0].recognize_text, 'Phụ đề có thể chỉnh trong CapCut');
assert.deepEqual(nativeCaptionTimeline.materials.texts[0].words.text, ['Phụ', ' ', 'đề', ' ', 'có', ' ', 'thể', ' ', 'chỉnh', ' ', 'trong', ' ', 'CapCut']);
assert.equal(nativeCaptionTimeline.materials.texts[0].words.start_time[0], 0);
assert.equal(nativeCaptionTimeline.materials.texts[0].words.end_time.at(-1), 3000);
assert.equal(nativeCaptionTimeline.materials.texts[0].words.start_time.length, nativeCaptionTimeline.materials.texts[0].words.text.length);
assert.equal(nativeCaptionTimeline.materials.texts[0].words.end_time.length, nativeCaptionTimeline.materials.texts[0].words.text.length);
assert.deepEqual(nativeCaptionTimeline.materials.texts[0].current_words, { start_time: [], end_time: [], text: [] });
assert.deepEqual(nativeCaptionTimeline.materials.texts[0].subtitle_keywords, { range: [] });
assert.deepEqual(nativeCaptionTimeline.materials.texts[0].caption_template_info, {
  resource_id: '', third_resource_id: '', resource_name: '', category_id: '', category_name: '',
  effect_id: '', request_id: '', is_new: false, source_platform: 0,
});
assert.equal(nativeCaptionTimeline.tracks[0].segments[0].track_attribute, 0);
assert.equal(nativeCaptionTimeline.tracks[0].segments[0].raw_segment_id, '');
assert.equal(nativeCaptionTimeline.function_assistant_info.auto_caption, false);
assert.deepEqual(nativeCaptionTimeline.function_assistant_info.auto_caption_segid_list, []);
assert.equal(nativeCaptionTimeline.config.subtitle_recognition_id, '');
assert.equal(nativeCaptionTimeline.config.subtitle_sync, true);
assert.deepEqual(nativeCaptionTimeline.config.subtitle_taskinfo, [{
  id: nativeCaptionTimeline.materials.texts[0].recognize_task_id,
  type: 10,
  language: 'en-US',
  content: '',
  remove_invalid_task_id: '',
  ai_accurate_recognize_enable: false,
  supplies_commit_id: '',
  is_local_asr: false,
}]);
assert.deepEqual(nativeCaptionTimeline.tracks[0].segments[0].extra_material_refs, ['caption_animation_caption-segment-1']);
assert.deepEqual(nativeCaptionTimeline.materials.material_animations, [{
  id: 'caption_animation_caption-segment-1', type: 'sticker_animation', animations: [], multi_language_current: 'none',
}]);
assert.equal(safeCapCutProjectName('  Tên / lỗi:*?  '), 'GenSuite - Tên lỗi');
assert.throws(() => buildCapCutDraftSpec({
  projectId: 'bad', projectName: '', sourceVideoPath: '', sourceDurationSec: 0,
  segments: [], subtitles: false, originalAudioVolume: 0,
}), /invalid source/);
assert.match(ipcSource, /value\.sourceDurationSec !== undefined/, 'Old projects may omit persisted source duration.');
assert.match(ipcSource, /selectedDraftDirectoryCandidates/, 'Folder selection must accept a project-store parent or child.');
assert.doesNotMatch(studioSource, /Dự án chưa có đủ dữ liệu thời lượng/, 'The UI must not block legacy projects before the source is probed.');
assert.match(studioSource, /role="alert"/, 'Export errors must be visible next to the action.');
const nativeDraft = {
  version: 360000,
  new_version: '179.0.0',
  tracks: [],
  materials: {},
  platform: { os: 'windows', app_source: 'cc', app_version: '9.0.0' },
  last_modified_platform: { os: 'windows', app_source: 'cc', app_version: '9.1.0' },
  color_space: 0,
  render_index_track_mode_on: true,
};
const compatibility = readCapCutCompatibilityProfile(nativeDraft, 'windows');
assert.ok(compatibility, 'A current app-authored draft must yield a compatibility profile.');
assert.equal(readCapCutCompatibilityProfile({ ...nativeDraft, platform: { ...nativeDraft.platform, os: 'mac' } }, 'windows'), null);
const compatibleDraft = applyCapCutCompatibilityProfile({
  version: 7,
  new_version: '',
  tracks: [],
  materials: {},
  platform: { os: 'mac', app_source: 'cc', app_version: '6.5.0' },
  last_modified_platform: { os: 'mac', app_source: 'cc', app_version: '6.5.0' },
}, compatibility);
compatibleDraft.tracks = [{ type: 'video', segments: [{}] }];
assert.equal(compatibleDraft.version, 360000);
assert.equal(compatibleDraft.new_version, '179.0.0');
assert.equal(compatibleDraft.platform.os, 'windows');
assert.equal(compatibleDraft.render_index_track_mode_on, true);
assert.equal(isCapCutDraftCompatible(compatibleDraft, compatibility), true);
const bundledCompatibility = bundledCapCutCompatibilityProfile('windows');
assert.ok(bundledCompatibility, 'Windows export must have a tested built-in compatibility fallback.');
assert.equal(bundledCapCutCompatibilityProfile('mac'), null, 'Unsupported built-in profiles must fail closed.');
const bundledDraft = applyCapCutCompatibilityProfile(nativeDraft, bundledCompatibility);
bundledDraft.tracks = [{ type: 'video', segments: [{}] }];
assert.equal(isCapCutDraftCompatible(bundledDraft, bundledCompatibility), true);
assert.match(ipcSource, /templateDraftDirectory/, 'Export must accept a user-selected project fallback.');
assert.match(ipcSource, /manualOutputDirectory/, 'Export must support a portable-folder fallback.');
assert.match(ipcSource, /capcut:preflight/, 'Compatibility must be checked before expensive processing begins.');
assert.match(ipcSource, /createCompatibilityTemplate/, 'Compilation must use an app-authored compatibility profile.');
assert.match(ipcSource, /compatibilityProfilePath/, 'A validated compatibility profile must be cached for later projects.');
assert.match(ipcSource, /loadCompatibilityProfile/, 'Export must recover from the validated compatibility cache.');
assert.match(ipcSource, /saveCompatibilityProfile/, 'A discovered native profile must be persisted transactionally.');
assert.match(ipcSource, /generated:\s*entry\.name\.startsWith\('GenSuite -'\)/, 'Discovery must distinguish native drafts from generated drafts.');
assert.match(ipcSource, /syncDraftRegistration/, 'The project index must be updated after the final duration is known.');
assert.match(ipcSource, /synchronizeVoiceTiming/, 'Voice speed metadata must be synchronized before registration.');
assert.match(ipcSource, /capcut:launch/, 'The desktop bridge must expose a dedicated editor launch action.');
assert.match(ipcSource, /shell\.openPath\(candidate\)/, 'The editor must be launched through the main process.');
assert.match(ipcSource, /CAPCUT_APP_UNAVAILABLE/, 'A missing editor installation must return a structured error.');
for (const code of ['CAPCUT_SOURCE_UNAVAILABLE', 'CAPCUT_SOURCE_UNREADABLE', 'CAPCUT_VOICE_UNAVAILABLE', 'CAPCUT_VOICE_UNREADABLE', 'CAPCUT_TIMELINE_INVALID', 'CAPCUT_SEGMENT_LIMIT']) {
  assert.match(ipcSource, new RegExp(code), `Draft preflight must preserve the specific ${code} cause.`);
}
assert.match(ipcSource, /segmentNumber:\s*index \+ 1/, 'Voice/timeline failures must identify the safe segment number.');
assert.match(ipcSource, /capcut:validateSource/, 'Persisted source checkpoints must be revalidated before reuse.');
assert.match(preloadSource, /capcut:launch/, 'The renderer bridge must expose the structured editor launch action.');
assert.match(preloadSource, /capcut:validateSource/, 'The renderer bridge must expose source checkpoint validation.');
assert.match(projectIpcSource, /AUDIO_EXTENSIONS/, 'Project recovery must restrict voice candidates to supported audio files.');
assert.match(projectIpcSource, /\.partial\./, 'Project recovery must reject interrupted voice artifacts.');
assert.match(projectIpcSource, /stat\.size > 0/, 'Project recovery must reject empty voice artifacts.');
assert.match(localizeStudioSource, />Mở CapCut</, 'The completed project card must offer CapCut as the primary action.');
assert.match(localizeStudioSource, />Mở thư mục</, 'The completed project card must retain a folder fallback.');
const registration = updateCapCutRegistrationMetadata({
  all_draft_store: [{ draft_id: 'draft-1', draft_name: 'old', tm_duration: 0 }],
  draft_ids: 1,
}, {
  draftId: 'draft-1',
  draftName: 'GenSuite project',
  durationUs: 2_000_000,
  modifiedUs: 3_000_000,
  timelineSize: 4096,
  draftJsonFile: 'draft/draft_content.json',
  draftPath: 'draft',
  draftsDirectory: 'drafts',
});
assert.ok(registration);
assert.equal(registration.entry.tm_duration, 2_000_000);
assert.equal(registration.entry.draft_timeline_materials_size, 4096);
assert.equal(registration.root.draft_ids, 1);

console.log('Kiểm tra ánh xạ dự án chỉnh sửa: đạt.');
