import { create } from 'zustand';
import { gensuiteFetch } from '../lib/gensuiteAuth';
import type { GenSuiteVoiceEngine } from '../providers/voice/GenSuiteVoiceAdapter';

const ACCOUNT_URL = 'https://api.gensuite.site/v1/me';

export type AccountTier = 'free' | 'starter' | 'basic' | 'standard' | 'pro';
type EntitlementStatus = 'idle' | 'loading' | 'ready' | 'error';

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
      set({
        status: 'ready',
        tier: normalizeTier(data?.tier),
        credits: Math.max(0, Number(data?.credits || 0)),
        allowedVoiceEngines: normalizeEngines(data?.allowedEngines),
        features: {
          localize: Boolean(data?.features?.localize),
          localizeCloud: Boolean(data?.features?.localizeCloud),
          premiumVoiceModels: Boolean(data?.features?.premiumVoiceModels),
        },
      });
    } catch {
      set({ status: 'error', ...EMPTY });
    }
  },
  reset: () => set({ status: 'idle', ...EMPTY }),
}));
