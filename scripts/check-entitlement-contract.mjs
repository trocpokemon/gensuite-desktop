import assert from 'node:assert/strict';
import { resolveAccountEntitlements } from '../src/lib/accountEntitlements.ts';

const freeTrial = resolveAccountEntitlements({
  tier: 'free',
  credits: 5_000,
  allowedEngines: null,
  features: { localizeCloud: false, premiumVoiceModels: false },
});

assert.equal(freeTrial.tier, 'free');
assert.equal(freeTrial.credits, 5_000);
assert.equal(freeTrial.allowedVoiceEngines, null, 'Free trial accounts without restrictions must access every online voice provider');
assert.equal(freeTrial.features.localizeCloud, false, 'Provider access must not silently unlock paid translation');
assert.equal(freeTrial.features.premiumVoiceModels, false, 'Provider access must not silently unlock premium-only models');

const restrictedTrial = resolveAccountEntitlements({ tier: 'free', credits: 5_000, allowedEngines: ['inworld'] });
assert.deepEqual(restrictedTrial.allowedVoiceEngines, ['genvoice'], 'Explicit server restrictions must be preserved and normalized');

const blockedTrial = resolveAccountEntitlements({ tier: 'free', credits: 5_000, allowedEngines: [] });
assert.deepEqual(blockedTrial.allowedVoiceEngines, [], 'An explicit empty restriction must not be treated as unrestricted');

const paid = resolveAccountEntitlements({ tier: 'pro', credits: 1_000, allowedEngines: null });
assert.equal(paid.features.localizeCloud, true);
assert.equal(paid.features.premiumVoiceModels, true);

console.log('Account entitlement contract checks passed.');
