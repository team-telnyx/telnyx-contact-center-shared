import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import {
  upsertVoiceApp,
  upsertOutboundVoiceProfile,
  upsertWebrtcCredentialConnection,
  createOwnerTelephonyCredential,
  searchPhoneNumbers,
  purchasePhoneNumber,
  assignPhoneNumberToVoiceApp,
  listOwnedPhoneNumbers,
  getAccountBalance,
} from '../lib/telnyx-bootstrap.mjs';

// Simple in-memory mock Telnyx API. Each test mutates `state` and adds a
// custom handler only when the default canned response isn't enough.
function makeTelnyxMock({ initial = {} } = {}) {
  const state = {
    voiceApps: initial.voiceApps || [],
    outboundProfiles: initial.outboundProfiles || [],
    credentialConnections: initial.credentialConnections || [],
    telephonyCredentials: initial.telephonyCredentials || [],
    phoneNumbers: initial.phoneNumbers || [],
    balance: initial.balance || null,
    handlers: new Map(),
    callLog: [],
  };

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    state.callLog.push({ url: String(url), method, body: init.body });
    const u = new URL(url);
    const handlerKey = `${method} ${u.pathname}`;
    if (state.handlers.has(handlerKey)) {
      return state.handlers.get(handlerKey)(u, JSON.parse(init.body || '{}'));
    }

    // Default behaviors (good enough for most tests; override via handlers when not).
    if (method === 'GET' && u.pathname === '/v2/call_control_applications') {
      const matches = state.voiceApps;
      return json(200, { data: matches });
    }
    if (method === 'POST' && u.pathname === '/v2/call_control_applications') {
      const body = JSON.parse(init.body);
      const created = { id: `app-${state.voiceApps.length + 1}`, application_name: body.application_name, webhook_event_url: body.webhook_event_url };
      state.voiceApps.push(created);
      return json(200, { data: created });
    }
    if (method === 'PATCH' && u.pathname.startsWith('/v2/call_control_applications/')) {
      const id = u.pathname.split('/').pop();
      const idx = state.voiceApps.findIndex((a) => a.id === id);
      if (idx >= 0) Object.assign(state.voiceApps[idx], JSON.parse(init.body));
      return json(200, { data: state.voiceApps[idx] });
    }
    if (method === 'GET' && u.pathname === '/v2/outbound_voice_profiles') {
      return json(200, { data: state.outboundProfiles });
    }
    if (method === 'POST' && u.pathname === '/v2/outbound_voice_profiles') {
      const body = JSON.parse(init.body);
      const created = { id: `ovp-${state.outboundProfiles.length + 1}`, name: body.name, traffic_type: body.traffic_type };
      state.outboundProfiles.push(created);
      return json(200, { data: created });
    }
    if (method === 'GET' && u.pathname === '/v2/credential_connections') {
      return json(200, { data: state.credentialConnections });
    }
    if (method === 'POST' && u.pathname === '/v2/credential_connections') {
      const body = JSON.parse(init.body);
      const created = { id: `conn-${state.credentialConnections.length + 1}`, connection_name: body.connection_name, webrtc: body.webrtc };
      state.credentialConnections.push(created);
      return json(200, { data: created });
    }
    if (method === 'PATCH' && u.pathname.startsWith('/v2/credential_connections/')) {
      const id = u.pathname.split('/').pop();
      const idx = state.credentialConnections.findIndex((c) => c.id === id);
      if (idx >= 0) Object.assign(state.credentialConnections[idx], JSON.parse(init.body));
      return json(200, { data: state.credentialConnections[idx] });
    }
    if (method === 'GET' && u.pathname === '/v2/telephony_credentials') {
      return json(200, { data: state.telephonyCredentials });
    }
    if (method === 'GET' && u.pathname === '/v2/balance') {
      return json(200, { data: state.balance || { balance: '0.00', credit_limit: '0.00', available_credit: '0.00' } });
    }
    if (method === 'POST' && u.pathname === '/v2/telephony_credentials') {
      const body = JSON.parse(init.body);
      const created = { id: `cred-${state.telephonyCredentials.length + 1}`, ...body, user_id: `user-${state.telephonyCredentials.length + 1}`, sip_username: `sipuser${state.telephonyCredentials.length + 1}` };
      state.telephonyCredentials.push(created);
      return json(200, { data: created });
    }
    if (method === 'GET' && u.pathname === '/v2/available_phone_numbers') {
      // Matches the real AvailablePhoneNumber schema — no `id` field.
      return json(200, { data: [{ phone_number: '+141****0134', cost_information: { monthly_cost: '1.00' } }] });
    }
    if (method === 'POST' && u.pathname === '/v2/number_orders') {
      const body = JSON.parse(init.body);
      // Real Telnyx CreateNumberOrderRequest keys off `phone_number` (the
      // E.164 string), not a `phone_number_id` — available_phone_numbers
      // results have no id field to send in the first place.
      const phoneNumber = body.phone_numbers?.[0]?.phone_number;
      const orderId = `order-${state.phoneNumbers.length + 1}`;
      // Deliberately DIFFERENT from the real /v2/phone_numbers resource id
      // below (numberOrderPhoneNumberId vs realPhoneNumberId) — this mirrors
      // the real Telnyx API, where NumberOrderPhoneNumber.id is a UUID
      // scoped to /v2/number_order_phone_numbers/{id}, NOT the id of the
      // real /v2/phone_numbers resource. A regression that goes back to
      // trusting `purchased.id` directly (instead of looking the real
      // resource up by E.164) would fail the PATCH assign test below.
      const numberOrderPhoneNumberId = `nopn-${state.phoneNumbers.length + 1}`;
      const realPhoneNumberId = `pn-${state.phoneNumbers.length + 1}`;
      state.phoneNumbers.push({ id: realPhoneNumberId, phone_number: phoneNumber || '+141****0134', order_id: orderId });
      return json(200, { data: { id: orderId, phone_numbers: [{ id: numberOrderPhoneNumberId, phone_number: phoneNumber || '+141****0134' }] } });
    }
    if (method === 'PATCH' && u.pathname.startsWith('/v2/phone_numbers/')) {
      const id = u.pathname.split('/').pop();
      return json(200, { data: { id, connection_id: JSON.parse(init.body).connection_id } });
    }
    if (method === 'GET' && u.pathname === '/v2/phone_numbers') {
      return json(200, { data: state.phoneNumbers });
    }
    return json(404, { errors: [{ detail: `Mock has no default for ${method} ${u.pathname}` }] });
  }

  return { state, fetchImpl };
}

function json(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

const API_KEY = 'KEY_TEST_123';
const BASE = 'https://api.telnyx.com';

describe('telnyx-bootstrap.mjs', () => {
  describe('upsertVoiceApp', () => {
    it('creates a Call Control application when none exists with that name', async () => {
      const mock = makeTelnyxMock();
      const result = await upsertVoiceApp({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-main-voice-app', webhookUrl: 'https://cc.example.com/api/voice/webhook',
      });
      assert.strictEqual(result.outcome, 'created');
      assert.ok(result.id.startsWith('app-'));
      assert.strictEqual(mock.state.voiceApps.length, 1);
      assert.strictEqual(mock.state.voiceApps[0].application_name, 'cc-main-voice-app');
    });

    it('is idempotent: re-running with the same name updates instead of creating a second app', async () => {
      const mock = makeTelnyxMock();
      const args = { fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'cc-main-voice-app', webhookUrl: 'https://cc.example.com/api/voice/webhook' };
      const first = await upsertVoiceApp(args);
      const second = await upsertVoiceApp({ ...args, webhookUrl: 'https://cc.example.com/api/voice/webhook-v2' });
      assert.strictEqual(first.outcome, 'created');
      assert.strictEqual(second.outcome, 'updated');
      assert.strictEqual(second.id, first.id);
      assert.strictEqual(mock.state.voiceApps.length, 1);
    });

    it('includes G711A/G711U inbound codecs (per hardphone-bridge parity)', async () => {
      const mock = makeTelnyxMock();
      await upsertVoiceApp({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-app', webhookUrl: 'https://cc.example.com/api/voice/webhook',
      });
      const createCall = mock.state.callLog.find((c) => c.method === 'POST' && c.url.endsWith('/v2/call_control_applications'));
      assert.ok(createCall, 'expected a POST to /v2/call_control_applications');
      const body = JSON.parse(createCall.body);
      assert.deepStrictEqual(body.inbound.codecs, ['G711A', 'G711U']);
    });

    it('attaches outbound_voice_profile_id when provided', async () => {
      const mock = makeTelnyxMock();
      await upsertVoiceApp({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-app', webhookUrl: 'https://x/y', outboundVoiceProfileId: 'ovp-123',
      });
      const createCall = mock.state.callLog.find((c) => c.method === 'POST' && c.url.endsWith('/v2/call_control_applications'));
      const body = JSON.parse(createCall.body);
      assert.strictEqual(body.outbound?.outbound_voice_profile_id, 'ovp-123');
    });

    it('rejects calls with missing required fields', async () => {
      const mock = makeTelnyxMock();
      await assert.rejects(() => upsertVoiceApp({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, webhookUrl: 'x' }), /requires \{ name \}/);
      await assert.rejects(() => upsertVoiceApp({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'x' }), /requires \{ webhookUrl \}/);
    });
  });

  describe('upsertOutboundVoiceProfile', () => {
    it('creates a profile when missing, returns outcome=found on second run', async () => {
      const mock = makeTelnyxMock();
      const created = await upsertOutboundVoiceProfile({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-main-outbound',
      });
      assert.strictEqual(created.outcome, 'created');

      const found = await upsertOutboundVoiceProfile({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-main-outbound',
      });
      assert.strictEqual(found.outcome, 'found');
      assert.strictEqual(found.id, created.id);
      assert.strictEqual(mock.state.outboundProfiles.length, 1);
    });

    it('uses conversational traffic_type by default (CC voice flows)', async () => {
      const mock = makeTelnyxMock();
      await upsertOutboundVoiceProfile({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'cc-out' });
      const createCall = mock.state.callLog.find((c) => c.method === 'POST' && c.url.endsWith('/v2/outbound_voice_profiles'));
      const body = JSON.parse(createCall.body);
      assert.strictEqual(body.traffic_type, 'conversational');
    });
  });

  describe('upsertWebrtcCredentialConnection', () => {
    it('creates a WebRTC credential connection with required outbound profile id', async () => {
      const mock = makeTelnyxMock();
      const result = await upsertWebrtcCredentialConnection({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-main-webrtc', outboundVoiceProfileId: 'ovp-123',
      });
      assert.strictEqual(result.outcome, 'created');
      const created = mock.state.credentialConnections[0];
      assert.strictEqual(created.webrtc, true);
      assert.strictEqual(created.connection_name, 'cc-main-webrtc');
    });

    it('is idempotent: second call updates rather than duplicates', async () => {
      const mock = makeTelnyxMock();
      const args = { fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'cc-webrtc', outboundVoiceProfileId: 'ovp-1' };
      const a = await upsertWebrtcCredentialConnection(args);
      const b = await upsertWebrtcCredentialConnection(args);
      assert.strictEqual(a.outcome, 'created');
      assert.strictEqual(b.outcome, 'updated');
      assert.strictEqual(mock.state.credentialConnections.length, 1);
      const patchCall = mock.state.callLog.find((c) => c.method === 'PATCH' && c.url.includes('/v2/credential_connections/'));
      assert.ok(patchCall, 'expected PATCH for the existing credential connection');
      assert.strictEqual(
        JSON.parse(patchCall.body).sip_uri_calling_preference,
        'unrestricted',
        're-running the wizard must repair legacy connections whose API default blocks SIP URI transfers',
      );
    });

    it('throws when outboundVoiceProfileId is missing (cannot create a WebRTC leg without it)', async () => {
      const mock = makeTelnyxMock();
      await assert.rejects(
        () => upsertWebrtcCredentialConnection({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'cc-webrtc' }),
        /requires \{ outboundVoiceProfileId \}/,
      );
    });

    it('sends user_name + password on POST (required by Telnyx schema, otherwise 422 "can\'t be blank")', async () => {
      const mock = makeTelnyxMock();
      await upsertWebrtcCredentialConnection({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        name: 'cc-main-webrtc', outboundVoiceProfileId: 'ovp-1',
      });
      const postCall = mock.state.callLog.find((c) => c.method === 'POST' && c.url.includes('/v2/credential_connections'));
      assert.ok(postCall, 'expected POST /v2/credential_connections');
      const body = JSON.parse(postCall.body);
      // Regression: both fields are REQUIRED per openapi/telnyx.json
      // CredentialConnection schema (user_name: 4-32 alphanumeric with ≥1 letter
      // in first 5 chars; password: 8-128 chars). Without them Telnyx returns
      // HTTP 422 with "can't be blank".
      assert.ok(body.user_name && /^[a-zA-Z0-9]{4,32}$/.test(body.user_name), `user_name invalid: ${body.user_name}`);
      assert.ok(body.password && body.password.length >= 8 && body.password.length <= 128, `password length invalid: ${body.password?.length}`);
      // user_name is deterministic from `name` so resume can find the same connection
      // and the owner can derive it without an extra lookup.
      assert.strictEqual(body.user_name, 'ccmainwebrtc');
      assert.strictEqual(body.sip_uri_calling_preference, 'unrestricted');
    });

    it('user_name derived deterministically from `name` (resume must hit the same value)', async () => {
      const mock = makeTelnyxMock();
      const args = { fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, name: 'cc-foo-bar-webrtc', outboundVoiceProfileId: 'ovp-1' };
      const a = await upsertWebrtcCredentialConnection(args);
      const b = await upsertWebrtcCredentialConnection(args);
      assert.strictEqual(a.userName, b.userName, 'user_name must be stable across calls');
      assert.ok(a.userName.length >= 4 && a.userName.length <= 32);
      // First 5 chars must contain a letter per the schema constraint.
      assert.ok(/[a-zA-Z]/.test(a.userName.slice(0, 5)), `first 5 chars need a letter, got: ${a.userName.slice(0, 5)}`);
    });
  });

  describe('createOwnerTelephonyCredential', () => {
    it('creates a telephony credential on the given connection', async () => {
      const mock = makeTelnyxMock();
      const result = await createOwnerTelephonyCredential({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        connectionId: 'conn-1', name: 'cc-main-owner',
      });
      assert.strictEqual(result.outcome, 'created');
      assert.ok(result.sipUsername);
      assert.strictEqual(mock.state.telephonyCredentials[0].name, 'cc-main-owner');
    });

    it('returns outcome=found on re-run (no duplicates per the find-by-name rule)', async () => {
      const mock = makeTelnyxMock();
      const args = { fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, connectionId: 'conn-1', name: 'cc-main-owner' };
      await createOwnerTelephonyCredential(args);
      const second = await createOwnerTelephonyCredential(args);
      assert.strictEqual(second.outcome, 'found');
      assert.strictEqual(mock.state.telephonyCredentials.length, 1);
    });
  });

  describe('getAccountBalance', () => {
    it('returns normalized numeric fields from the Telnyx /v2/balance response', async () => {
      const mock = makeTelnyxMock({
        initial: { balance: { balance: '12.34', credit_limit: '5.00', available_credit: '17.34', pending: '0.00' } },
      });
      const out = await getAccountBalance({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY });
      assert.strictEqual(out.balance, 12.34);
      assert.strictEqual(out.creditLimit, 5);
      assert.strictEqual(out.availableCredit, 17.34);
      assert.strictEqual(out.currency, 'USD');
    });

    it('throws on missing apiKey', async () => {
      const mock = makeTelnyxMock();
      await assert.rejects(() => getAccountBalance({ fetchImpl: mock.fetchImpl, basePath: BASE }), /requires \{ apiKey \}/);
    });
  });

  describe('phone numbers', () => {
    it('searchPhoneNumbers returns whatever the API gives for US country code', async () => {
      const mock = makeTelnyxMock();
      const results = await searchPhoneNumbers({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, countryCode: 'US', limit: 5,
      });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].phone_number, '+141****0134');
    });

    it('purchasePhoneNumber returns orderId + phoneNumberId + E.164 (keyed by phone_number, not an id — available_phone_numbers has no id field)', async () => {
      const mock = makeTelnyxMock();
      const result = await purchasePhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: 'KEY_TEST', phoneNumber: '+141****0134',
        pollIntervalMs: 1, // no real waiting in the test
      });
      assert.ok(result.orderId);
      assert.ok(result.phoneNumberId);
      assert.strictEqual(result.phoneNumber, '+141****0134');
      // Confirm the request body actually sent `phone_number` (the E.164
      // string), not a `phone_number_id` — regression for the "Error:
      // purchasePhoneNumber requires { phoneNumberId }" production bug where
      // AvailablePhoneNumber results have no id to send in the first place.
      const orderCall = mock.state.callLog.find((c) => c.method === 'POST' && c.url.endsWith('/v2/number_orders'));
      const body = JSON.parse(orderCall.body);
      assert.strictEqual(body.phone_numbers[0].phone_number, '+141****0134');
      assert.strictEqual(body.phone_numbers[0].phone_number_id, undefined);
    });

    it('REGRESSION: purchasePhoneNumber returns the REAL /v2/phone_numbers resource id, not the NumberOrderPhoneNumber id from the order response', async () => {
      // The order response's phone_numbers[].id is a DIFFERENT resource
      // (number_order_phone_number, a UUID) from the real /v2/phone_numbers
      // id (numeric string) that PATCH /v2/phone_numbers/{id} and
      // voice_flow_phone_numbers actually need. Confirmed against the live
      // Telnyx API — PATCHing with the order-phone-number id 404s.
      const mock = makeTelnyxMock();
      const result = await purchasePhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: 'KEY_TEST', phoneNumber: '+141****0134',
        pollIntervalMs: 1,
      });
      // The mock's order response used 'nopn-1' as the order-phone-number id
      // and 'pn-1' as the real /v2/phone_numbers id — purchasePhoneNumber
      // must return the latter, resolved via the E.164 lookup.
      assert.strictEqual(result.phoneNumberId, 'pn-1',
        `expected the REAL /v2/phone_numbers id ('pn-1'), got '${result.phoneNumberId}' — did the E.164 lookup get skipped?`);
      assert.notStrictEqual(result.phoneNumberId, 'nopn-1',
        'must not return the NumberOrderPhoneNumber id from the order response directly');
      // And that id must actually work for the PATCH assign call.
      const assignResult = await assignPhoneNumberToVoiceApp({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: 'KEY_TEST',
        phoneNumberId: result.phoneNumberId, voiceAppId: 'app-1',
      });
      assert.strictEqual(assignResult.outcome, 'assigned');
    });

    it('purchasePhoneNumber throws a clear error if the number never appears under /v2/phone_numbers within the poll timeout', async () => {
      const mock = makeTelnyxMock();
      // Override the phone_numbers GET filter to never return a match, so the
      // lookup never resolves — must not hang and must not silently return a
      // bogus id.
      const originalFetch = mock.fetchImpl;
      const neverFoundFetch = async (url, init) => {
        const u = new URL(url);
        if (init?.method === undefined && u.pathname === '/v2/phone_numbers') {
          return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}', clone() { return this; } };
        }
        return originalFetch(url, init);
      };
      await assert.rejects(
        () => purchasePhoneNumber({
          fetchImpl: neverFoundFetch, basePath: BASE, apiKey: 'KEY_TEST', phoneNumber: '+141****0134',
          pollTimeoutMs: 10, pollIntervalMs: 2,
        }),
        /did not appear under \/v2\/phone_numbers/,
      );
    });

    it('assignPhoneNumberToVoiceApp PATCHes connection_id', async () => {
      const mock = makeTelnyxMock();
      const result = await assignPhoneNumberToVoiceApp({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        phoneNumberId: 'pn-1', voiceAppId: 'app-1',
      });
      assert.strictEqual(result.outcome, 'assigned');
      const patchCall = mock.state.callLog.find((c) => c.method === 'PATCH' && c.url.endsWith('/v2/phone_numbers/pn-1'));
      const body = JSON.parse(patchCall.body);
      assert.strictEqual(body.connection_id, 'app-1');
    });

    it('listOwnedPhoneNumbers paginates and (optionally) filters by assigned voice app', async () => {
      const mock = makeTelnyxMock({
        initial: {
          phoneNumbers: [
            { id: 'pn-1', phone_number: '+14155550134', connection_id: 'app-1' },
            { id: 'pn-2', phone_number: '+14155550199', connection_id: 'app-2' },
          ],
        },
      });
      const all = await listOwnedPhoneNumbers({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY });
      assert.strictEqual(all.length, 2);
      const assignedTo1 = await listOwnedPhoneNumbers({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, assignedToVoiceAppId: 'app-1',
      });
      assert.strictEqual(assignedTo1.length, 1);
      assert.strictEqual(assignedTo1[0].id, 'pn-1');
    });
  });
});
