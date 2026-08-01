import type { GenSuiteVoice } from './GenSuiteVoiceAdapter';
import rawVoices from './capcutTtsVoices.json';

export interface CapCutTtsVoice extends GenSuiteVoice {
  resourceId: string;
}

const LANGUAGE_LABELS: Record<string, string> = {
  'vi-VN': 'Tiếng Việt', 'en-US': 'English', 'zh-CN': '中文', 'ja-JP': '日本語',
  'es-ES': 'Español', 'th-TH': 'ภาษาไทย', 'id-ID': 'Bahasa Indonesia',
  'pt-BR': 'Português', 'fr-FR': 'Français', 'de-DE': 'Deutsch',
};

function inferredGender(voiceType: string): string {
  const value = voiceType.toLowerCase();
  if (value.includes('female') || value.includes('_nv') || value.includes('girl')) return 'Nữ';
  if (value.includes('male') || value.includes('_nan') || value.includes('boy')) return 'Nam';
  return '';
}

export const CAPCUT_TTS_VOICES: CapCutTtsVoice[] = rawVoices
  .map((voice) => {
    const language = LANGUAGE_LABELS[voice.lang] ?? voice.lang;
    const gender = inferredGender(voice.voice_type);
    return {
      voiceId: voice.voice_type,
      resourceId: voice.resource_id,
      name: voice.display_name,
      category: gender ? `${gender} · ${language}` : language,
      labels: { gender, language: voice.lang },
    };
  })
  // Some captured catalogs contain duplicate voice ids. Keep the newest usable
  // mapping unique so selection and preview state remain deterministic.
  .filter((voice, index, list) => list.findIndex((item) => item.voiceId === voice.voiceId) === index);

export const DEFAULT_CAPCUT_VOICE = 'BV421_vivn_streaming';

export function capCutVoiceById(voiceId: string): CapCutTtsVoice | undefined {
  return CAPCUT_TTS_VOICES.find((voice) => voice.voiceId === voiceId);
}
