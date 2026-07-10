import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  deleteCredentialConnection,
  deleteVoiceApp,
  deleteOutboundVoiceProfile,
  releasePhoneNumber,
  deleteTelnyxResources,
} from '../lib/telnyx-bootstrap.mjs';

// Minimal fake Response with the subset deleteIfExists() actually uses
// (status, ok, clone().json()).
function fakeResponse({ status, body = {} }) {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
  res.clone = () => res;
  return res;
}

function fetchLogger(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return responder(String(url), init);
  };
  return { fetchImpl, calls };
}

describe('telnyx-bootstrap.mjs — delete helpers', () => {
  it('deleteCredentialConnection: DELETEs the right path and reports deleted', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: { data: {} } }));
    const result = await deleteCredentialConnection({ fetchImpl, apiKey: 'k', id: 'sip-123' });
    assert.strictEqual(result.outcome, 'deleted');
    assert.strictEqual(calls[0].method, 'DELETE');
    assert.ok(calls[0].url.endsWith('/v2/credential_connections/sip-123'));
  });

  it('deleteVoiceApp: 404 is treated as success (not-found), not an error', async () => {
    const { fetchImpl } = fetchLogger(() => fakeResponse({ status: 404, body: {} }));
    const result = await deleteVoiceApp({ fetchImpl, apiKey: 'k', id: 'app-1' });
    assert.strictEqual(result.outcome, 'not-found');
  });

  it('deleteVoiceApp: real API error (e.g. still in use) throws with detail', async () => {
    const { fetchImpl } = fetchLogger(() => fakeResponse({
      status: 400,
      body: { errors: [{ title: 'Bad Request', detail: 'Cannot be deleted when in use by a number or a telephone data endpoint' }] },
    }));
    await assert.rejects(
      () => deleteVoiceApp({ fetchImpl, apiKey: 'k', id: 'app-1' }),
      /in use by a number/,
    );
  });

  it('deleteOutboundVoiceProfile: skipped (no id) does not call fetch', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: {} }));
    const result = await deleteOutboundVoiceProfile({ fetchImpl, apiKey: 'k', id: null });
    assert.strictEqual(result.outcome, 'skipped');
    assert.strictEqual(calls.length, 0);
  });

  it('releasePhoneNumber: DELETEs /v2/phone_numbers/{id}', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: { data: { status: 'deleted' } } }));
    const result = await releasePhoneNumber({ fetchImpl, apiKey: 'k', id: 'num-1' });
    assert.strictEqual(result.outcome, 'deleted');
    assert.ok(calls[0].url.endsWith('/v2/phone_numbers/num-1'));
  });

  it('deleteTelnyxResources: calls steps in the dependency-safe order (sip -> number -> callFlowVoiceApp -> voiceApp -> ovp)', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: { data: {} } }));
    const results = await deleteTelnyxResources({
      fetchImpl,
      apiKey: 'k',
      sipConnectionId: 'sip-1',
      phoneNumberId: 'num-1',
      voiceAppId: 'app-1',
      outboundVoiceProfileId: 'ovp-1',
      callFlowVoiceAppId: 'flowapp-1',
      releaseNumber: true,
    });
    const paths = calls.map((c) => c.url.split('/v2/')[1]);
    assert.deepStrictEqual(paths, [
      'credential_connections/sip-1',
      'phone_numbers/num-1',
      'call_control_applications/flowapp-1',
      'call_control_applications/app-1',
      'outbound_voice_profiles/ovp-1',
    ]);
    assert.strictEqual(results.sipConnection.outcome, 'deleted');
    assert.strictEqual(results.phoneNumber.outcome, 'deleted');
    assert.strictEqual(results.callFlowVoiceApp.outcome, 'deleted');
    assert.strictEqual(results.voiceApp.outcome, 'deleted');
    assert.strictEqual(results.outboundVoiceProfile.outcome, 'deleted');
  });

  it('deleteTelnyxResources: releaseNumber=false (default) never calls the phone number delete endpoint', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: { data: {} } }));
    await deleteTelnyxResources({
      fetchImpl,
      apiKey: 'k',
      sipConnectionId: 'sip-1',
      phoneNumberId: 'num-1',
      voiceAppId: 'app-1',
      outboundVoiceProfileId: 'ovp-1',
    });
    const paths = calls.map((c) => c.url.split('/v2/')[1]);
    assert.ok(!paths.some((p) => p.startsWith('phone_numbers/')));
  });

  it('deleteTelnyxResources: one step failing does not block the remaining steps (partial-failure resilience)', async () => {
    const { fetchImpl } = fetchLogger((url) => {
      if (url.includes('call_control_applications/app-1')) {
        return fakeResponse({ status: 400, body: { errors: [{ detail: 'still in use' }] } });
      }
      return fakeResponse({ status: 200, body: { data: {} } });
    });
    const results = await deleteTelnyxResources({
      fetchImpl,
      apiKey: 'k',
      sipConnectionId: 'sip-1',
      voiceAppId: 'app-1',
      outboundVoiceProfileId: 'ovp-1',
    });
    assert.strictEqual(results.sipConnection.outcome, 'deleted');
    assert.strictEqual(results.voiceApp.outcome, 'error');
    assert.match(results.voiceApp.error, /still in use/);
    // OVP step still ran despite voiceApp erroring.
    assert.strictEqual(results.outboundVoiceProfile.outcome, 'deleted');
  });

  it('deleteTelnyxResources: no ids supplied at all -> empty results, no fetch calls', async () => {
    const { fetchImpl, calls } = fetchLogger(() => fakeResponse({ status: 200, body: {} }));
    const results = await deleteTelnyxResources({ fetchImpl, apiKey: 'k' });
    assert.deepStrictEqual(results, {});
    assert.strictEqual(calls.length, 0);
  });
});
