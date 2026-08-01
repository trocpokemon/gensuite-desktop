import { ipcMain } from 'electron';
import { constants, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectDir } from './project';
import type { CapCutTtsPreviewArgs, CapCutTtsPreviewResult, CapCutTtsSynthesizeArgs, CapCutTtsSynthesizeResult } from '../../src/shared/types';

// This integration intentionally contains only the text-to-speech flow needed by
// GenSuite. Internal protocol details stay in the main process and are never
// forwarded to renderer errors or user-visible logs.
const BASE_URL = 'https://editor-api-sg.capcutapi.com';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----`;

const deviceId = `7${BigInt(`0x${randomBytes(8).toString('hex')}`).toString().slice(0, 19).padEnd(19, '0')}`;
const DEVICE = {
  aid: '359289', app_name: 'CapCut', appvr: '8.7.0', version_name: '8.7.0', version_code: '8.7.0',
  channel: 'capcutpc_google', device_platform: 'mac', device_type: 'MacBookPro17,4',
  device_brand: 'MacBookPro17,4', os_version: '15.7.4', device_id: deviceId, iid: deviceId,
  region: 'VN', loc: 'VN', lan: 'vi-VN', pf: '3', tdid: deviceId,
};

type TaskEnvelope = { data?: { tasks?: Array<Record<string, unknown>> }; ret?: string | number };
const running = new Map<string, AbortController>();

function compact(value: unknown): string { return JSON.stringify(value); }
function md5(value: string): string { return createHash('md5').update(value, 'utf8').digest('hex'); }
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function safeName(value: string): string { return value.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120) || 'voice'; }

function query(includeRegion: boolean, babi?: object): URLSearchParams {
  const params = new URLSearchParams({
    app_name: DEVICE.app_name, device_type: DEVICE.device_type, os_version: DEVICE.os_version,
    channel: DEVICE.channel, version_name: DEVICE.version_name, device_brand: DEVICE.device_brand,
    device_id: DEVICE.device_id, iid: DEVICE.iid, version_code: DEVICE.version_code,
    device_platform: DEVICE.device_platform, aid: DEVICE.aid,
  });
  if (includeRegion) params.set('region', DEVICE.region);
  if (babi) params.set('babi_param', compact(babi));
  return params;
}

function headers(url: string, body: string): Record<string, string> {
  const now = String(Math.floor(Date.now() / 1000));
  const trace = randomUUID().replace(/-/g, '');
  const pathname = url.split('?', 1)[0];
  return {
    'content-type': 'application/json', appvr: DEVICE.appvr, ch: DEVICE.channel, 'device-time': now,
    lan: DEVICE.lan, loc: DEVICE.loc, pf: DEVICE.pf, 'sign-ver': '1', tdid: DEVICE.tdid,
    'x-ss-stub': md5(body), 'x-ss-dp': DEVICE.aid, 'x-khronos': now,
    'x-tt-trace-id': `00-${trace}-${trace.slice(0, 16)}-01`,
    'user-agent': 'Cronet/TTNetVersion:1d7cc3b1 2025-07-16 QuicVersion:52c2b40d 2025-04-03',
    'store-country-code': 'vn', 'store-country-code-src': 'did', 'is-dispatch-us-ttp': '0',
    'is-app-region-us-ttp': '0', 'app-sdk-version': DEVICE.appvr, appid: DEVICE.aid,
    sign: md5(`9e2c|${pathname.slice(-7)}|3|${DEVICE.appvr}|${now}|${DEVICE.tdid}|11ac`),
  };
}

function payloadSignature(ssml: string, extraInfo: string): string {
  const input = `appid:${DEVICE.aid}&did:${DEVICE.device_id}&creditDisable:false&ssml:${md5(ssml)}&extraInfo:${extraInfo}`;
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(input)).toString('base64');
}

async function postTask(pathname: string, body: object, includeRegion: boolean, signal: AbortSignal, babi?: object): Promise<TaskEnvelope> {
  const bodyText = compact(body);
  const url = `${BASE_URL}${pathname}?${query(includeRegion, babi).toString()}`;
  const response = await fetch(url, { method: 'POST', headers: headers(url, bodyText), body: bodyText, signal });
  if (!response.ok) throw new Error('remote');
  const result = await response.json() as TaskEnvelope;
  if (String(result.ret ?? '0') !== '0') throw new Error('remote');
  return result;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
  });
}

async function createTask(args: CapCutTtsSynthesizeArgs, signal: AbortSignal): Promise<{ id: string; token: string }> {
  const speed = Math.max(0.5, Math.min(1.5, Number(args.speed) || 1)).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const babi = { feature_entrance: 'editor', feature_entrance_detail: 'editor-feature-text_to_speech', feature_key: 'text_to_speech', scenario: 'video_editor' };
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\n    <voice name="${args.voiceId}" mock_tone_info="" platform="sami" resource_id="${args.resourceId}" emotion="" emotion_scale="0" style="" role="" moyin_emotion="" is_clone_tone="false" need_subtitle_timestamp="false">\n        <prosody rate="${speed}">${escapeXml(args.text.trim())}</prosody>\n    </voice>\n</speak>`;
  const extraInfo = compact({ benefit_info: {} });
  const payload = compact({
    audio_format: 'mp3', babi_param: compact(babi), credit_disable: false, extra_info: extraInfo,
    need_merge_voice: false, need_subtitle_timestamp: false, scene: 'text_to_speech', ssml,
    sign: payloadSignature(ssml, extraInfo),
  });
  const result = await postTask('/lv/v1/common_task/new', {
    bind_id: randomUUID(), can_queue: true, enter_from: 'text_to_speech',
    tasks: [{ context: randomUUID(), payload, req_key: 'sami_text_to_speech', task_version: 'v3' }],
  }, true, signal, babi);
  const task = result.data?.tasks?.[0];
  const id = String(task?.id ?? '');
  const token = String(task?.token ?? '');
  if (!id || !token) throw new Error('remote');
  return { id, token };
}

async function waitForAudio(task: { id: string; token: string }, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await postTask('/lv/v1/common_task/query', {
      tasks: [{ bind_id: '', id: task.id, req_key: 'sami_text_to_speech', task_version: 'v3', token: task.token }],
    }, false, signal);
    const row = result.data?.tasks?.[0];
    const status = String(row?.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'fail') throw new Error('remote');
    if (status === 'succeed' || status === 'success') {
      const payload = JSON.parse(String(row?.payload ?? '{}')) as { audio_subtitles?: Array<{ speech_url?: string }> };
      const audioUrl = String(payload.audio_subtitles?.[0]?.speech_url ?? '');
      const parsed = new URL(audioUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('remote');
      return audioUrl;
    }
    await delay(800, signal);
  }
  throw new Error('timeout');
}

async function fetchAudio(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error('download');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > 50 * 1024 * 1024) throw new Error('download');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('download');
  return bytes;
}

async function generateAudio(args: CapCutTtsSynthesizeArgs, signal: AbortSignal): Promise<Buffer> {
  const task = await createTask(args, signal);
  const audioUrl = await waitForAudio(task, signal);
  return fetchAudio(audioUrl, signal);
}

export async function synthesizeCapCutTts(args: CapCutTtsSynthesizeArgs): Promise<CapCutTtsSynthesizeResult> {
  if (!args?.projectId || !args.jobId || !args.segmentId || !args.text?.trim() || !args.voiceId || !/^\d{10,24}$/.test(args.resourceId)) {
    throw new Error('Không thể tạo giọng từ nội dung này. Hãy kiểm tra lựa chọn và thử lại.');
  }
  if (args.text.length > 10_000) throw new Error('Đoạn văn quá dài. Hãy chia thành các đoạn ngắn hơn rồi thử lại.');
  const controller = new AbortController();
  running.set(args.jobId, controller);
  const audioDir = path.join(projectDir(safeName(args.projectId)), 'audio');
  const output = path.join(audioDir, `${safeName(args.segmentId)}.mp3`);
  const partial = `${output}.${safeName(args.jobId)}.part`;
  try {
    await fs.mkdir(audioDir, { recursive: true });
    const bytes = await generateAudio(args, controller.signal);
    await fs.writeFile(partial, bytes);
    await fs.rename(partial, output);
    return { audioPath: output };
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw new Error('voice:cancelled');
    if (error instanceof Error && error.message === 'timeout') {
      throw new Error('Tạo giọng mất nhiều thời gian hơn dự kiến. Hãy thử lại sau ít phút.');
    }
    throw new Error('Chưa thể tạo giọng lúc này. Hãy kiểm tra kết nối mạng hoặc thử lại sau.');
  } finally {
    running.delete(args.jobId);
  }
}

export async function previewCapCutTts(args: CapCutTtsPreviewArgs): Promise<CapCutTtsPreviewResult> {
  if (!args?.jobId || !args.text?.trim() || !args.voiceId || !/^\d{10,24}$/.test(args.resourceId)) {
    throw new Error('Không thể tạo bản nghe thử cho giọng này.');
  }
  const controller = new AbortController();
  running.set(args.jobId, controller);
  try {
    const bytes = await generateAudio({ ...args, projectId: 'preview', segmentId: 'preview' }, controller.signal);
    return { audioBase64: bytes.toString('base64') };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('voice:cancelled');
    if (error instanceof Error && error.message === 'timeout') {
      throw new Error('Bản nghe thử mất nhiều thời gian hơn dự kiến. Hãy thử lại sau.');
    }
    throw new Error('Chưa thể phát bản nghe thử lúc này. Hãy thử lại sau.');
  } finally {
    running.delete(args.jobId);
  }
}

export function registerCapCutTtsIpc(): void {
  ipcMain.handle('capcuttts:synthesize', async (_event, args: CapCutTtsSynthesizeArgs) => synthesizeCapCutTts(args));
  ipcMain.handle('capcuttts:preview', async (_event, args: CapCutTtsPreviewArgs) => previewCapCutTts(args));

  ipcMain.handle('capcuttts:kill', async (_event, jobId: string): Promise<boolean> => {
    const controller = running.get(jobId);
    if (!controller) return false;
    controller.abort();
    running.delete(jobId);
    return true;
  });
}
