import { create } from 'zustand';
import { gensuiteFetch } from '../lib/gensuiteAuth';
import type { GenSuiteVoiceEngine } from '../providers/voice/GenSuiteVoiceAdapter';

const ACCOUNT_URL = 'https://api.gensuite.site/v1/me';

export type AccountTier = 'free' | 'starter' | 'basic' | 'standard' | 'pro';
type EntitlementStatus = 'idle' | 'loading' | 'ready' | 'error';

const VOICE_CONCURRENCY_BY_TIER: Record<AccountTier, number> = {
  free: 1,
  starter: 2,
  basic: 2,
  standard: 4,
  pro: 6,
};

/** Mirrors the account concurrency contract used by GenSuite services. */
export function voiceConcurrencyForTier(tier: AccountTier): number {
  return VOICE_CONCURRENCY_BY_TIER[tier];
}

interface AccountFeatures {
  localize: boolean;
  localizeCloud: boolean;
  premiumVoiceModels: boolean;
}

interface EntitlementStore {
  status: EntitlementStatus;
  tier: AccountTier;
  credits: number;
  allowedVoiceEngines: GenSuiteVoiceEngine[] | null;
  features: AccountFeatures;
  load: () => Promise<void>;
  reset: () => void;
}

const EMPTY = {
  tier: 'free' as AccountTier,
  credits: 0,
  allowedVoiceEngines: [] as GenSuiteVoiceEngine[],
  features: { localize: true, localizeCloud: false, premiumVoiceModels: false },
};

const normalizeTier = (value: unknown): AccountTier => {
  const tier = String(value || '').toLowerCase();
  return ['free', 'starter', 'basic', 'standard', 'pro'].includes(tier) ? tier as AccountTier : 'free';
};

const normalizeEngines = (value: unknown): GenSuiteVoiceEngine[] | null => {
  if (!Array.isArray(value)) return null;
  const mapped = value.map((engine) => String(engine) === 'inworld' ? 'genvoice' : String(engine));
  return mapped.filter((engine): engine is GenSuiteVoiceEngine => ['genvoice', 'elevenlabs', 'minimax'].includes(engine));
};

export const useEntitlementStore = create<EntitlementStore>((set) => ({
  status: 'idle',
  ...EMPTY,
  load: async () => {
    set({ status: 'loading' });
    try {
      const response = await gensuiteFetch(ACCOUNT_URL);
      const data = await response.json().catch(() => null as any);
      if (!response.ok) throw new Error(String(data?.message || 'Không thể tải quyền tài khoản.'));
      const tier = normalizeTier(data?.tier ?? data?.plan?.tier ?? data?.plan?.name ?? data?.plan ?? data?.subscription?.tier);
      const paidLocalizeTier = tier === 'basic' || tier === 'standard' || tier === 'pro';
      const paidVoiceTier = tier === 'starter' || paidLocalizeTier;
      const rawFeatures = data?.features ?? data?.entitlements ?? {};
      const allowedEngines = normalizeEngines(
        data?.allowedEngines
        ?? data?.allowedVoiceEngines
        ?? rawFeatures?.allowedVoiceEngines
        ?? rawFeatures?.voiceEngines,
      );
      set({
        status: 'ready',
        tier,
        credits: Math.max(0, Number(data?.credits || 0)),
        allowedVoiceEngines: paidVoiceTier && (!allowedEngines || allowedEngines.length === 0) ? null : allowedEngines,
        features: {
          localize: Boolean(rawFeatures?.localize ?? rawFeatures?.videoLocalize ?? true),
          localizeCloud: Boolean(rawFeatures?.localizeCloud || rawFeatures?.localize_cloud || paidLocalizeTier),
          premiumVoiceModels: Boolean(rawFeatures?.premiumVoiceModels || rawFeatures?.premium_voice_models || paidVoiceTier),
        },
      });
    } catch {
      set({ status: 'error', ...EMPTY });
    }
  },
  reset: () => set({ status: 'idle', ...EMPTY }),
}));
