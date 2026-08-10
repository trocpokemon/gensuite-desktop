import assert from 'node:assert/strict';
import { classifyGoogleApiFailure, googleResponseWasBlocked } from '../src/lib/googleApiErrors.ts';

assert.equal(classifyGoogleApiFailure(401, { error: { status: 'UNAUTHENTICATED' } }), 'api-key-invalid');
assert.equal(classifyGoogleApiFailure(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), 'api-key-invalid');
assert.equal(classifyGoogleApiFailure(403, { error: { status: 'PERMISSION_DENIED' } }), 'access-denied');
assert.equal(classifyGoogleApiFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } }), 'quota-exhausted');
assert.equal(classifyGoogleApiFailure(429, { error: { message: 'Rate limit reached. Too many requests.' } }), 'rate-limited');
assert.equal(classifyGoogleApiFailure(404, { error: { message: 'Model not found.' } }), 'model-unavailable');
assert.equal(classifyGoogleApiFailure(400, { error: { message: 'Request blocked by safety policy.' } }), 'content-blocked');
assert.equal(classifyGoogleApiFailure(400, { error: { status: 'INVALID_ARGUMENT' } }), 'request-rejected');
assert.equal(classifyGoogleApiFailure(503, { error: { status: 'UNAVAILABLE' } }), 'service-unavailable');
assert.equal(googleResponseWasBlocked({ promptFeedback: { blockReason: 'SAFETY' } }), true);
assert.equal(googleResponseWasBlocked({ candidates: [{ finishReason: 'STOP' }] }), false);

console.log('Google API error classification checks passed.');
