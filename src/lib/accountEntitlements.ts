import type { GenSuiteVoiceEngine } from '../providers/voice/GenSuiteVoiceAdapter';

export type AccountTier = 'free' | 'starter' | 'basic' | 'standard' | 'pro';

export interface AccountFeatures {
  localize: boolean;
  localizeCloud: boolean;
  premiumVoiceModels: boolean;
}

export interface AccountEntitlements {
  tier: AccountTier;
  credits: number;
  allowedVoiceEngines: GenSuiteVoiceEngine[] | null;
  features: AccountFeatures;
}

const normalizeTier = (value: unknown): AccountTier => {
  const tier = String(value || '').toLowerCase();
  return ['free', 'starter', 'basic', 'standard', 'pro'].includes(tier) ? tier as AccountTier : 'free';
};

const normalizeEngines = (value: unknown): GenSuiteVoiceEngine[] | null => {
  if (!Array.isArray(value)) return null;
  const mapped = value.map((engine) => String(engine) === 'inworld' ? 'genvoice' : String(engine));
  return mapped.filter((engine): engine is GenSuiteVoiceEngine => ['genvoice', 'elevenlabs', 'minimax'].includes(engine));
};

/**
 * Mirrors the web account contract:
 * - `null` provider restrictions mean all online voice providers are available;
 * - an array is an explicit restriction, including an empty array;
 * - plan tier controls premium workflow/model features, not trial provider access.
 */
export function resolveAccountEntitlements(data: any): AccountEntitlements {
  const tier = normalizeTier(data?.tier ?? data?.plan?.tier ?? data?.plan?.name ?? data?.plan ?? data?.subscription?.tier);
  const paidLocalizeTier = tier === 'basic' || tier === 'standard' || tier === 'pro';
  const paidVoiceTier = tier === 'starter' || paidLocalizeTier;
  const rawFeatures = data?.features ?? data?.entitlements ?? {};
  const allowedVoiceEngines = normalizeEngines(
    data?.allowedEngines
    ?? data?.allowedVoiceEngines
    ?? rawFeatures?.allowedVoiceEngines
    ?? rawFeatures?.voiceEngines,
  );

  return {
    tier,
    credits: Math.max(0, Number(data?.credits || 0)),
    allowedVoiceEngines,
    features: {
      localize: Boolean(rawFeatures?.localize ?? rawFeatures?.videoLocalize ?? true),
      localizeCloud: Boolean(rawFeatures?.localizeCloud || rawFeatures?.localize_cloud || paidLocalizeTier),
      premiumVoiceModels: Boolean(rawFeatures?.premiumVoiceModels || rawFeatures?.premium_voice_models || paidVoiceTier),
    },
  };
}
