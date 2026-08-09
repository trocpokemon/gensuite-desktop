import { readFile } from 'node:fs/promises';

const [studio, panel, voicePanel, appStyles, appErrors, projectStore, diagnosticSummary, preload, mainProcess, mainErrors, runtimeStore, projectHome, app, jobMain, jobContract, translationReliability, voiceReliability, cloudRecognition, entitlements, freeVoiceAdapter, freeVoiceMain] = await Promise.all([
  readFile('src/steps/LocalizeStudio.tsx', 'utf8'),
  readFile('src/components/PipelineProgressPanel.tsx', 'utf8'),
  readFile('src/components/VoiceConfigPanel.tsx', 'utf8'),
  readFile('src/index.css', 'utf8'),
  readFile('src/shared/appErrors.ts', 'utf8'),
  readFile('src/store/projectStore.ts', 'utf8'),
  readFile('src/shared/diagnosticSummary.ts', 'utf8'),
  readFile('electron/preload.ts', 'utf8'),
  readFile('electron/main.ts', 'utf8'),
  readFile('electron/ipc/appErrors.ts', 'utf8'),
  readFile('src/store/localizeRuntimeStore.ts', 'utf8'),
  readFile('src/components/ProjectHome.tsx', 'utf8'),
  readFile('src/App.tsx', 'utf8'),
  readFile('electron/ipc/localizeJob.ts', 'utf8'),
  readFile('src/shared/localizeJob.ts', 'utf8'),
  readFile('src/providers/script/translationReliability.ts', 'utf8'),
  readFile('src/providers/voice/voiceReliability.ts', 'utf8'),
  readFile('src/providers/transcription/GenSuiteSttAdapter.ts', 'utf8'),
  readFile('src/store/entitlementStore.ts', 'utf8'),
  readFile('src/providers/voice/CapCutTtsAdapter.ts', 'utf8'),
  readFile('electron/ipc/capcuttts.ts', 'utf8'),
]);
const violations = [];

if (!/free:\s*1[\s\S]*starter:\s*2[\s\S]*basic:\s*2[\s\S]*standard:\s*4[\s\S]*pro:\s*6/.test(entitlements)) {
  violations.push('Số luồng tạo voice chưa bám đúng tier tài khoản.');
}
if (!/voiceEngine === 'capcuttts'\s*\?\s*voiceConcurrencyForTier\(tier\)\s*:\s*1/.test(studio)
  || !/Array\.from\(\{ length: Math\.min\(concurrency, pending\.length\) \}/.test(studio)) {
  violations.push('GenVoice Free TTS 2 chưa dùng pool theo tier trong pipeline dịch video.');
}
if (!freeVoiceAdapter.includes('concurrency: voiceConcurrencyForTier(useEntitlementStore.getState().tier)')
  || !freeVoiceMain.includes('acquireVoiceSlot(concurrency, controller.signal)')
  || !freeVoiceMain.includes('Math.min(concurrency, chunks.length)')) {
  violations.push('Ngân sách luồng GenVoice Free TTS 2 chưa được áp dụng thống nhất cho văn bản dài.');
}

for (const id of ['download', 'recognition', 'translation', 'voice', 'capcut']) {
  if (!new RegExp(`id:\\s*['\"]${id}['\"]`).test(studio)) violations.push(`Thiếu giai đoạn tiến độ ${id}.`);
}
for (const removed of ['SubtitleDesigner', 'alignSceneSubtitle', 'window.gensuite.ffmpeg.redub', "id: 'subtitle'", "id: 'merge'", "id: 'save'"]) {
  if (studio.includes(removed)) violations.push(`Luồng gọn vẫn còn logic đã loại bỏ: ${removed}.`);
}
if (!studio.includes('<PipelineProgressPanel') || !studio.includes('inactivitySeconds={inactivitySeconds}')) {
  violations.push('Màn hình xử lý chưa hiển thị tiến độ và tuổi heartbeat.');
}
if (!studio.includes('useState(true)') || !studio.includes('setDetailsOpen(true)')) {
  violations.push('Chi tiết quá trình xử lý chưa được mở mặc định khi vào màn hình hoặc đổi dự án.');
}

if (!studio.includes('copyFailureDiagnostics')
  || !studio.includes('window.gensuite.diagnostics.copyFailure(')
  || !studio.includes('Sao chép log lỗi')
  || !preload.includes("'diagnostics:copy-failure'")
  || !mainProcess.includes("ipcMain.handle('diagnostics:copy-failure'")
  || !mainProcess.includes('internalDiagnosticFor(error.diagnosticId)')
  || !mainErrors.includes('rememberInternalDiagnostic(diagnosticId, internalDiagnostics)')) {
  violations.push('Lỗi làm dừng pipeline chưa có nút sao chép thông tin chẩn đoán an toàn.');
}

if (!studio.includes("stage === 'error' && failedStep && pipelineFailure")) {
  violations.push('Nút sao chép chẩn đoán chưa được giới hạn cho trạng thái pipeline thực sự bị dừng.');
}

if (!studio.includes('const occurredAt = new Date().toISOString()') || !studio.includes('setPipelineFailure(null)')) {
  violations.push('Log hỗ trợ chưa được chụp đúng thời điểm lỗi hoặc chưa được xóa khi bắt đầu lần xử lý mới.');
}
const singleFailureCopy = mainProcess.match(/ipcMain\.handle\('diagnostics:copy-failure'[\s\S]*?\n  \}\);/u)?.[0] ?? '';
if (!singleFailureCopy.includes('appVersion: app.getVersion()')
  || !singleFailureCopy.includes('occurredAt')
  || !singleFailureCopy.includes('diagnosticId: error.diagnosticId')
  || !singleFailureCopy.includes('operation: internal.operation')
  || !singleFailureCopy.includes('classifier: internal.classifier')
  || !singleFailureCopy.includes('exitCode: internal.exitCode')
  || singleFailureCopy.includes('recentErrors')
  || singleFailureCopy.includes('loadRecords()')) {
  violations.push('Log lỗi tại chỗ phải có phiên bản và chỉ chứa đúng sự cố hiện tại, không kèm lịch sử lỗi.');
}
if (!studio.includes('restorePipelineProgress(project)')
  || !studio.includes('project.transcriptionVersion === 4')
  || !studio.includes('project.capcutDraftPath')
  || !studio.includes('Đã lưu ${voiceCount}/${scenes.length} câu · Có thể tiếp tục')) {
  violations.push('Pipeline chưa khôi phục checkpoint tải, nhận dạng, dịch, voice và CapCut.');
}
if (!studio.includes('restoredProjectIdRef')
  || !studio.includes('restoredRuntime?.steps ?? restorePipelineProgress(project)')
  || !studio.includes('useLocalizeRuntimeStore.getState().jobs[project.id]')) {
  violations.push('Checkpoint chưa được nạp lại khi mở dự án khác.');
}
if (!runtimeStore.includes("export type LocalizeRuntimeStatus = 'running' | 'blocked' | 'error' | 'cancelled' | 'completed'")
  || !studio.includes("status: 'error'")
  || !studio.includes("status: 'completed'")
  || !app.includes("setLocalizeSetupStep(localizeRuntime ? 'process' : 'source')")) {
  violations.push('Tác vụ nền chưa giữ trạng thái hoặc chưa tự mở lại bước tiến độ của đúng dự án.');
}
if (!projectHome.includes('localizeOverallPercent(runtime)')
  || !projectHome.includes('LOCALIZE_STAGE_LABEL[runtime.stage]')
  || !projectHome.includes("runtime?.status === 'error' || runtime?.status === 'blocked'")) {
  violations.push('Thẻ dự án ở Home chưa hiển thị công đoạn, phần trăm và lỗi của tác vụ nền.');
}
const runPipelineBody = studio.match(/const runPipeline = async[\s\S]*?\n  \};\n\n  const chooseCapCutDirectory/u)?.[0] ?? '';
if (!/touchStage\('download', 0, 'Đang chuẩn bị tải video'\);[\s\S]*onSetupStepChange\('process'\);[\s\S]*requestAnimationFrame[\s\S]*runPipeline\(true\)/u.test(studio)
  || runPipelineBody.includes("onSetupStepChange('process')")) {
  violations.push('Pipeline phải chuyển sang bước 2 và render màn tiến trình trước khi bắt đầu tải video.');
}
if (!studio.includes('const startFromSetup = async () =>')
  || !studio.includes('if (startValidationMissing)')
  || !studio.includes('data-validation-error={missingVideo || undefined}')
  || studio.includes("disabled={setupStep === 'source' && !readyToStart}")) {
  violations.push('Nút bắt đầu chưa luôn bấm được hoặc chưa chặn chuyển bước bằng validation trực quan.');
}
if (!jobMain.includes("ipcMain.handle('localize:start'")
  || !jobMain.includes("ipcMain.handle('localize:update'")
  || !jobMain.includes('localize-job.backup.json')
  || !jobMain.includes('reconcileStale')
  || !jobContract.includes('LOCALIZE_STAGE_WEIGHTS')
  || !runtimeStore.includes('window.gensuite.localize.list()')
  || !runtimeStore.includes('window.gensuite.localize.onJob')) {
  violations.push('Pipeline V2 chưa có manifest bền vững, heartbeat và cơ chế attach tác vụ nền.');
}
if (translationReliability.includes('localStorage')
  || voiceReliability.includes('localStorage')
  || cloudRecognition.includes('localStorage')
  || !translationReliability.includes("scope: 'translation'")
  || !voiceReliability.includes("scope: 'voice'")
  || !cloudRecognition.includes("scope: 'cloud-recognition'")) {
  violations.push('Checkpoint dịch, voice hoặc nhận dạng trực tuyến vẫn phụ thuộc bộ nhớ tạm của màn hình.');
}
if (!studio.includes("type SourceInputMode = 'link' | 'file'")
  || !studio.includes('role="tablist"')
  || !studio.includes('Liên kết video</button>')
  || !studio.includes('File từ máy</button>')
  || !studio.includes("patchSettings({ localizeSourceInputMode: 'link' })")
  || !studio.includes('Video từ liên kết đã sẵn sàng')
  || !studio.includes('localizeSourceUrl: nextUrl')
  || !studio.includes("project.settings.localizePreparedSourceMode === 'file'")
  || !studio.includes('const sourceSelectionChanged =')
  || !studio.includes('Liên kết đã thay đổi.')
  || !studio.includes('!capcutReady || sourceSelectionChanged')
  || !projectStore.includes('localizeSourceInputMode: raw.settings?.localizeSourceInputMode')
  || !projectStore.includes('localizePreparedSourceUrl:')) {
  violations.push('Nguồn video chưa được tách thành hai tab liên kết và file từ máy.');
}
if (!voicePanel.includes('providerMissing') || !voicePanel.includes('voiceMissing')
  || !voicePanel.includes('validation-attention') || !appStyles.includes('@keyframes validation-attention-shake')) {
  violations.push('Nhà cung cấp/giọng đọc bắt buộc chưa có viền đỏ và hiệu ứng rung thống nhất.');
}
if (!voicePanel.includes("'Chọn nhà cung cấp trước'")
  || !voicePanel.includes('disabled={catalogBusy || !voiceProviderConfirmed}')
  || !studio.includes('Boolean(project.settings.localizeVoiceProviderConfirmed) && !voiceConfig.voiceId')) {
  violations.push('Giọng mặc định vẫn có thể hiển thị hoặc tương tác trước khi chọn nhà cung cấp.');
}
if (!studio.includes('await recognizeAndTranslate(sourcePath)') || !studio.includes('await createVoices()') || !studio.includes('await createCapCutDraft()')) {
  violations.push('Thứ tự nhận dạng → dịch → voice → CapCut chưa được khóa rõ ràng.');
}
if (!studio.includes('window.gensuite.capcut.exportDraft') || !studio.includes('subtitles: true')) {
  violations.push('Luồng dịch chưa đưa track phụ đề chữ thuần vào dự án CapCut.');
}
if (!studio.includes("step.id === 'capcut'")
  || !studio.includes("?.status === 'completed'")
  || !studio.includes('capcutReady && !sourceSelectionChanged')) {
  violations.push('Thẻ dự án CapCut sẵn sàng vẫn có thể hiện khi lần xuất hiện tại đang chờ hoặc bị lỗi.');
}
if (studio.includes('subtitleConfig:') || studio.includes('SubtitleDesigner') || studio.includes('alignSceneSubtitle')) {
  violations.push('Luồng dịch đang áp thiết kế hoặc xử lý phụ đề riêng thay vì để CapCut tùy biến.');
}
if (!studio.includes('originalAudioVolume: 0') || studio.includes('Âm thanh video gốc')) {
  violations.push('Luồng dịch vẫn còn logic giữ âm thanh video gốc.');
}
if (!studio.includes('normalizePipelineError') || !studio.includes('reportFailure')) {
  violations.push('Lỗi pipeline chưa được chuẩn hóa và gắn mã chẩn đoán.');
}
if (!studio.includes('loginRequiredPlatform(failure)')
  || !studio.includes("window.gensuite.ytdlp.loginDouyin()")
  || !studio.includes('Mở cửa sổ xác nhận')
  || !studio.includes('clearVideoPlatformSession')) {
  violations.push('Lỗi tải từ nền tảng cần phiên truy cập chưa có bảng xác nhận, đăng nhập lại và xóa phiên cũ.');
}
if (!projectStore.includes('capcutDraftsDirectory') || !projectStore.includes('capcutDraftPath: undefined')) {
  violations.push('Thiếu lưu thư mục CapCut hoặc cơ chế vô hiệu checkpoint khi dữ liệu thay đổi.');
}
if (!panel.includes('seconds >= 30') || !panel.includes('seconds >= 90')) {
  violations.push('Cảnh báo chờ phản hồi và dấu hiệu gián đoạn chưa đủ hai ngưỡng.');
}
for (const code of ['TRANSLATION_REQUEST_TIMEOUT', 'TRANSLATION_UNEXPECTED', 'VOICE_CREDITS_INSUFFICIENT', 'CAPCUT_EXPORT_FAILED']) {
  if (!appErrors.includes(`${code}:`)) violations.push(`Thiếu mã lỗi ${code}.`);
}

if (violations.length) {
  console.error(`Kiểm tra pipeline dịch video thất bại:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}

console.log('Kiểm tra pipeline dịch video: đạt (tải → nhận dạng → dịch → voice → CapCut; checkpoint, heartbeat và lỗi GS đầy đủ).');
