import type { EdgeTtsVoice } from '../../shared/types';

// edge-tts exposes ~300 neural voices across ~90 locales. The live list is
// fetched at runtime via window.gensuite.edgetts.voices(); this small curated
// set is the offline fallback (and seeds the UI before the fetch resolves).
// Vietnamese leads because this is a Vietnamese-first app.
export const EDGE_TTS_FALLBACK_VOICES: EdgeTtsVoice[] = [
  { shortName: 'vi-VN-HoaiMyNeural', friendlyName: 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)', locale: 'vi-VN', gender: 'Female' },
  { shortName: 'vi-VN-NamMinhNeural', friendlyName: 'Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)', locale: 'vi-VN', gender: 'Male' },
  { shortName: 'en-US-AriaNeural', friendlyName: 'Microsoft Aria Online (Natural) - English (United States)', locale: 'en-US', gender: 'Female' },
  { shortName: 'en-US-GuyNeural', friendlyName: 'Microsoft Guy Online (Natural) - English (United States)', locale: 'en-US', gender: 'Male' },
  { shortName: 'en-GB-SoniaNeural', friendlyName: 'Microsoft Sonia Online (Natural) - English (United Kingdom)', locale: 'en-GB', gender: 'Female' },
  { shortName: 'ja-JP-NanamiNeural', friendlyName: 'Microsoft Nanami Online (Natural) - Japanese (Japan)', locale: 'ja-JP', gender: 'Female' },
  { shortName: 'ko-KR-SunHiNeural', friendlyName: 'Microsoft SunHi Online (Natural) - Korean (Korea)', locale: 'ko-KR', gender: 'Female' },
  { shortName: 'zh-CN-XiaoxiaoNeural', friendlyName: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', locale: 'zh-CN', gender: 'Female' },
  { shortName: 'fr-FR-DeniseNeural', friendlyName: 'Microsoft Denise Online (Natural) - French (France)', locale: 'fr-FR', gender: 'Female' },
  { shortName: 'es-ES-ElviraNeural', friendlyName: 'Microsoft Elvira Online (Natural) - Spanish (Spain)', locale: 'es-ES', gender: 'Female' },
];

// Intl.DisplayNames (available in the Chromium renderer) turns a locale into a
// localized language + country label, so we don't hand-maintain ~90 locales.
const langNames = new Intl.DisplayNames(['vi'], { type: 'language', fallback: 'code' });
const regionNames = new Intl.DisplayNames(['vi'], { type: 'region', fallback: 'code' });

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// 'ar-BH' → 'Tiếng Ả Rập · Bahrain'. Falls back to the raw locale if unmappable.
export function localeLabel(locale: string): string {
  const [lang, region] = locale.split('-');
  let label = locale;
  try {
    const languageLabel = capitalize(langNames.of(lang) || lang);
    const regionLabel = region ? regionNames.of(region.toUpperCase()) : '';
    label = regionLabel && regionLabel !== region.toUpperCase() ? `${languageLabel} · ${regionLabel}` : languageLabel;
  } catch {
    // Intl may throw on malformed subtags — keep the raw locale.
  }
  return label;
}

// Extract the bare voice name from the service's verbose friendlyName
// ('Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)' → 'HoaiMy').
// Falls back to the shortName's name segment ('vi-VN-HoaiMyNeural' → 'HoaiMy').
export function edgeVoiceName(voice: EdgeTtsVoice): string {
  const fromFriendly = voice.friendlyName.match(/Microsoft\s+(.+?)\s+Online/i)?.[1];
  if (fromFriendly) return fromFriendly.trim();
  const parts = voice.shortName.split('-');
  return parts.slice(2).join('-').replace(/Neural$/i, '').replace(/Multilingual$/i, ' Multilingual').trim() || voice.shortName;
}

export const DEFAULT_EDGE_VOICE = 'vi-VN-HoaiMyNeural';
