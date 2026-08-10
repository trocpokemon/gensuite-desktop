import { create } from 'zustand';
import { gensuiteFetch } from '../lib/gensuiteAuth';
import type { GenSuiteVoiceEngine } from '../providers/voice/GenSuiteVoiceAdapter';
import { resolveAccountEntitlements } from '../lib/accountEntitlements';
import type { AccountFeatures, AccountTier } from '../lib/accountEntitlements';

const ACCOUNT_URL = 'https://api.gensuite.site/v1/me';

export type { AccountTier } from '../lib/accountEntitlements';
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

export const useEntitlementStore = create<EntitlementStore>((set) => ({
  status: 'idle',
  ...EMPTY,
  load: async () => {
    set({ status: 'loading' });
    try {
      const response = await gensuiteFetch(ACCOUNT_URL);
      const data = await response.json().catch(() => null as any);
      if (!response.ok) throw new Error(String(data?.message || 'Không thể tải quyền tài khoản.'));
      const entitlements = resolveAccountEntitlements(data);
      set({
        status: 'ready',
        ...entitlements,
      });
    } catch {
      set({ status: 'error', ...EMPTY });
    }
  },
  reset: () => set({ status: 'idle', ...EMPTY }),
}));
