import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  runTelnyxBootstrap,
  pickPhoneNumber,
  nameForDeployment,
} from '../lib/telnyx-bootstrap-orchestrator.mjs';

function makeTelnyxMock({ initial = {} } = {}) {
  const state = {
    voiceApps: initial.voiceApps || [],
    outboundProfiles: initial.outboundProfiles || [],
    credentialConnections: initial.credentialConnections || [],
    telephonyCredentials: initial.telephonyCredentials || [],
    phoneNumbers: initial.phoneNumbers || [],
    balance: initial.balance || { balance: '100.00', credit_limit: '0.00', available_credit: '100.00', pending: '0.00' },
    handlers: new Map(),
    callLog: [],
  };

  function json(status, payload) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  }

  async function fetchImpl(url, init = {}) {
    const method = init.method || 'GET';
    state.callLog.push({ url: String(url), method, body: init.body });
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/v2/call_control_applications') return json(200, { data: state.voiceApps });
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
    if (method === 'GET' && u.pathname === '/v2/outbound_voice_profiles') return json(200, { data: state.outboundProfiles });
    if (method === 'POST' && u.pathname === '/v2/outbound_voice_profiles') {
      const body = JSON.parse(init.body);
      const created = { id: `ovp-${state.outboundProfiles.length + 1}`, name: body.name, traffic_type: body.traffic_type };
      state.outboundProfiles.push(created);
      return json(200, { data: created });
    }
    if (method === 'GET' && u.pathname === '/v2/credential_connections') return json(200, { data: state.credentialConnections });
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
    if (method === 'GET' && u.pathname === '/v2/telephony_credentials') return json(200, { data: state.telephonyCredentials });
    if (method === 'GET' && u.pathname === '/v2/balance') return json(200, { data: state.balance });
    if (method === 'POST' && u.pathname === '/v2/telephony_credentials') {
      const body = JSON.parse(init.body);
      const created = { id: `cred-${state.telephonyCredentials.length + 1}`, ...body, user_id: `user-${state.telephonyCredentials.length + 1}`, sip_username: `sipuser${state.telephonyCredentials.length + 1}` };
      state.telephonyCredentials.push(created);
      return json(200, { data: created });
    }
    if (method === 'GET' && u.pathname === '/v2/available_phone_numbers') {
      return json(200, { data: [
        { id: 'num-1', phone_number: '+141****0134', cost_information: { monthly_cost: '1.00' } },
        { id: 'num-2', phone_number: '+141****0199', cost_information: { monthly_cost: '2.00' } },
      ] });
    }
    if (method === 'GET' && u.pathname === '/v2/phone_numbers') return json(200, { data: state.phoneNumbers });
    if (method === 'POST' && u.pathname === '/v2/number_orders') {
      const body = JSON.parse(init.body);
      const orderId = `order-${state.phoneNumbers.length + 1}`;
      const phoneNumberId = `pn-${state.phoneNumbers.length + 1}`;
      const num = { id: phoneNumberId, phone_number: '+141****0134', connection_id: null };
      state.phoneNumbers.push(num);
      return json(200, { data: { id: orderId, phone_numbers: [{ id: phoneNumberId, phone_number: '+141****0134' }] } });
    }
    if (method === 'PATCH' && u.pathname.startsWith('/v2/phone_numbers/')) {
      const id = u.pathname.split('/').pop();
      const idx = state.phoneNumbers.findIndex((p) => p.id === id);
      if (idx >= 0) {
        state.phoneNumbers[idx].connection_id = JSON.parse(init.body).connection_id;
      }
      return json(200, { data: state.phoneNumbers[idx] });
    }
    return json(404, { errors: [{ detail: `Mock has no default for ${method} ${u.pathname}` }] });
  }

  return { state, fetchImpl };
}

const API_KEY = 'KEY_TEST';
const BASE = 'https://api.telnyx.com';

describe('telnyx-bootstrap-orchestrator.mjs', () => {
  describe('nameForDeployment', () => {
    it('joins deploymentName + suffix with a single hyphen', () => {
      assert.strictEqual(nameForDeployment({ deploymentName: 'cc-main', suffix: 'voice-app' }), 'cc-main-voice-app');
    });
  });

  describe('runTelnyxBootstrap (no number)', () => {
    it('creates Voice App, OVP, WebRTC credential connection, and the Default Call Flow\'s own dedicated voice app (no owner credential — the app creates that lazily on first login)', async () => {
      const mock = makeTelnyxMock();
      const result = await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        log: () => {},
      });
      assert.ok(result.voiceAppId.startsWith('app-'));
      assert.ok(result.outboundVoiceProfileId.startsWith('ovp-'));
      assert.ok(result.sipConnectionId.startsWith('conn-'));
      assert.ok(result.defaultFlowVoiceAppId.startsWith('app-'));
      assert.notStrictEqual(result.defaultFlowVoiceAppId, result.voiceAppId, 'Default Call Flow must get its OWN voice app, not reuse the main one');
      assert.strictEqual(result.ownerCredentialId, undefined);
      assert.strictEqual(result.phoneNumber, null);
      // Exactly 4 create calls (voice app, OVP, webrtc connection, Default
      // Call Flow voice app) — no owner telephony credential is created here.
      // Excludes the 3 shipped-media-file upload attempts ensureCoreTelnyxObjects
      // also makes (see telnyx-media.test.mjs for dedicated coverage of that
      // upload path) — this mock has no /v2/media handler, so those 3 POSTs
      // hit the catch-all 404 and are caught as best-effort failures by
      // ensureMediaFiles, but the attempt is still logged in callLog.
      const creates = mock.state.callLog.filter((c) => c.method === 'POST' && c.url.includes('/v2/call_control_applications')
        || c.method === 'POST' && c.url.includes('/v2/outbound_voice_profiles')
        || c.method === 'POST' && c.url.includes('/v2/credential_connections'));
      assert.strictEqual(creates.length, 4);
    });

    it('envUpdates maps the returned IDs to the expected docker env var names, including TELNYX_DEFAULT_FLOW_VOICE_APP_ID', async () => {
      const mock = makeTelnyxMock();
      const { envUpdates } = await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        log: () => {},
      });
      assert.strictEqual(envUpdates.TELNYX_CALL_CONTROL_ID, mock.state.voiceApps[0].id);
      assert.strictEqual(envUpdates.TELNYX_OUTBOUND_VOICE_PROFILE, mock.state.outboundProfiles[0].id);
      assert.strictEqual(envUpdates.TELNYX_SIP_CONNECTION_ID, mock.state.credentialConnections[0].id);
      assert.strictEqual(envUpdates.TELNYX_DEFAULT_FLOW_VOICE_APP_ID, mock.state.voiceApps[1].id);
      assert.strictEqual(envUpdates.TELNYX_OWNER_TELEPHONY_CREDENTIAL_ID, undefined);
      assert.strictEqual(envUpdates.TELNYX_OWNER_TELEPHONY_USER_NAME, undefined);
    });

    it('the Default Call Flow voice app\'s webhook URL is derived from the fixed SEEDED_DEFAULT_FLOW_ID (readable up front, before the DB row exists)', async () => {
      const mock = makeTelnyxMock();
      await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        log: () => {},
      });
      const defaultFlowCreate = mock.state.callLog.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/call_control_applications'))[1];
      const body = JSON.parse(defaultFlowCreate.body);
      assert.strictEqual(body.webhook_event_url, 'https://cc.example.com/api/voice/webhook/incoming/00000000-cc00-4000-8000-000000000001');
      assert.strictEqual(body.inbound.sip_subdomain, '00000000-cc00-4000-8000-000000000001');
    });

    it('attaches the OVP id to the voice app, the WebRTC connection, and the Default Call Flow voice app (no orphans)', async () => {
      const mock = makeTelnyxMock();
      await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        log: () => {},
      });
      const ovpId = mock.state.outboundProfiles[0].id;
      const voiceAppCreates = mock.state.callLog.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/call_control_applications'));
      const webrtcCreate = mock.state.callLog.find((c) => c.method === 'POST' && c.url.endsWith('/v2/credential_connections'));
      assert.strictEqual(JSON.parse(voiceAppCreates[0].body).outbound.outbound_voice_profile_id, ovpId);
      assert.strictEqual(JSON.parse(voiceAppCreates[1].body).outbound.outbound_voice_profile_id, ovpId);
      assert.strictEqual(JSON.parse(webrtcCreate.body).outbound.outbound_voice_profile_id, ovpId);
    });

    it('reuses resources on second run (idempotent — never duplicates)', async () => {
      const mock = makeTelnyxMock();
      const args = {
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        log: () => {},
      };
      const a = await runTelnyxBootstrap(args);
      const b = await runTelnyxBootstrap(args);
      assert.strictEqual(a.voiceAppId, b.voiceAppId);
      assert.strictEqual(a.outboundVoiceProfileId, b.outboundVoiceProfileId);
      assert.strictEqual(a.sipConnectionId, b.sipConnectionId);
      assert.strictEqual(a.defaultFlowVoiceAppId, b.defaultFlowVoiceAppId);
      assert.strictEqual(mock.state.voiceApps.length, 2);
      assert.strictEqual(mock.state.outboundProfiles.length, 1);
      assert.strictEqual(mock.state.credentialConnections.length, 1);
    });

    it('throws clearly when apiKey/deploymentName/baseUrl are missing', async () => {
      const mock = makeTelnyxMock();
      await assert.rejects(
        () => runTelnyxBootstrap({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, deploymentName: '', baseUrl: 'https://x.y' }),
        /requires \{ deploymentName \}/,
      );
      await assert.rejects(
        () => runTelnyxBootstrap({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, deploymentName: 'x', baseUrl: '' }),
        /requires \{ baseUrl \}/,
      );
      await assert.rejects(
        () => runTelnyxBootstrap({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: '', deploymentName: 'x', baseUrl: 'https://x.y' }),
        /requires \{ apiKey \}/,
      );
    });
  });

  describe('pickPhoneNumber', () => {
    it('returns a sorted candidate list with the cheapest first', async () => {
      const mock = makeTelnyxMock();
      const logs = [];
      const { candidates } = await pickPhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        countryCode: 'US', log: (...args) => logs.push(args.join(' ')),
      });
      assert.strictEqual(candidates.length, 2);
      assert.strictEqual(candidates[0].phone_number, '+141****0134');
      assert.ok(logs.some((l) => l.includes('Found 2')));
    });

    it('returns pendingConfirmation:true so the wizard gates the purchase', async () => {
      const mock = makeTelnyxMock();
      const { pendingConfirmation } = await pickPhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, countryCode: 'US', log: () => {},
      });
      assert.strictEqual(pendingConfirmation, true);
    });

    it('fetches /v2/balance and returns balance + canAfford=true when funds cover the cheapest candidate', async () => {
      const mock = makeTelnyxMock({
        initial: { balance: { balance: '50.00', credit_limit: '0.00', available_credit: '50.00', pending: '0.00' } },
      });
      const { balance, canAfford } = await pickPhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, countryCode: 'US', log: () => {},
      });
      assert.ok(balance, 'expected balance object');
      assert.strictEqual(balance.balance, 50);
      assert.strictEqual(balance.availableCredit, 50);
      assert.strictEqual(canAfford, true);
      const balanceCall = mock.state.callLog.find((c) => c.url.endsWith('/v2/balance'));
      assert.ok(balanceCall, 'expected GET /v2/balance call');
    });

    it('throws INSUFFICIENT_BALANCE when available_credit < cheapest candidate cost', async () => {
      const mock = makeTelnyxMock({
        // Mock returns 2 candidates: $1.00 and $2.00/mo (see default mock above).
        initial: { balance: { balance: '0.50', credit_limit: '0.00', available_credit: '0.50', pending: '0.00' } },
      });
      await assert.rejects(
        () => pickPhoneNumber({ fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, countryCode: 'US', log: () => {} }),
        (err) => err.code === 'INSUFFICIENT_BALANCE' && err.balance.availableCredit === 0.5 && err.cheapestMonthlyCost === 1.0,
      );
    });

    it('does NOT throw when skipBalanceCheck=true (used by cc doctor)', async () => {
      const mock = makeTelnyxMock({
        initial: { balance: { balance: '0.00', credit_limit: '0.00', available_credit: '0.00', pending: '0.00' } },
      });
      const { canAfford } = await pickPhoneNumber({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY, countryCode: 'US', skipBalanceCheck: true, log: () => {},
      });
      assert.strictEqual(canAfford, true, 'canAfford stays true when balance check is skipped');
      const balanceCall = mock.state.callLog.find((c) => c.url.endsWith('/v2/balance'));
      assert.ok(!balanceCall, 'expected NO /v2/balance call when skipBalanceCheck=true');
    });
  });

  describe('runTelnyxBootstrap (with pickedNumber = unattended mode)', () => {
    it('purchases and assigns the picked number to the Default Call Flow\'s voice app (not the main WebRTC-agent voice app); sets TELNYX_MAIN_FROM_NUMBER + TELNYX_MAIN_FROM_NUMBER_ID in envUpdates', async () => {
      const mock = makeTelnyxMock();
      const result = await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        pickedNumber: { id: 'num-1', phone_number: '+141****0134' },
        log: () => {},
      });
      assert.strictEqual(result.phoneNumber, '+141****0134');
      assert.strictEqual(result.envUpdates.TELNYX_MAIN_FROM_NUMBER, '+141****0134');
      assert.strictEqual(result.envUpdates.TELNYX_MAIN_FROM_NUMBER_ID, result.phoneNumberId);
      // Assigned to the Default Call Flow's OWN voice app, not the main one —
      // this replaces the old two-step "assign to main, then re-point to
      // flow" dance that only worked for the Local target.
      assert.strictEqual(mock.state.phoneNumbers[0].connection_id, result.defaultFlowVoiceAppId);
      assert.notStrictEqual(result.defaultFlowVoiceAppId, result.voiceAppId);
    });

    it('treats already-owned + already-assigned number as a no-op (resume safety)', async () => {
      const mock = makeTelnyxMock({
        initial: {
          phoneNumbers: [{ id: 'pn-existing', phone_number: '+141****0134', connection_id: 'app-2' }],
          voiceApps: [
            { id: 'app-1', application_name: 'cc-main-voice-app', webhook_event_url: 'https://x' },
            { id: 'app-2', application_name: 'cc-main-default-flow', webhook_event_url: 'https://x/incoming/y' },
          ],
          outboundProfiles: [{ id: 'ovp-1', name: 'cc-main-outbound' }],
          credentialConnections: [{ id: 'conn-1', connection_name: 'cc-main-webrtc' }],
          telephonyCredentials: [{ id: 'cred-1', name: 'cc-main-owner', connection_id: 'conn-1' }],
        },
      });
      const result = await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        pickedNumber: { id: 'pn-existing', phone_number: '+141****0134' },
        log: () => {},
      });
      assert.strictEqual(result.phoneNumber, '+141****0134');
      // No new number order created
      assert.ok(!mock.state.callLog.some((c) => c.method === 'POST' && c.url.endsWith('/v2/number_orders')));
    });

    it('REGRESSION: already-owned but NOT-yet-assigned number is assigned, not re-purchased (fixes a production bug where an interrupted prior run that bought the number but died before assigning it would try to buy it again)', async () => {
      const mock = makeTelnyxMock({
        initial: {
          // Owned, but connection_id is empty — e.g. a prior wizard run
          // purchased it and then crashed before the assign PATCH.
          phoneNumbers: [{ id: 'pn-existing', phone_number: '+141****0134', connection_id: '' }],
          voiceApps: [{ id: 'app-1', application_name: 'cc-main-voice-app', webhook_event_url: 'https://x' }],
          outboundProfiles: [{ id: 'ovp-1', name: 'cc-main-outbound' }],
          credentialConnections: [{ id: 'conn-1', connection_name: 'cc-main-webrtc' }],
          telephonyCredentials: [{ id: 'cred-1', name: 'cc-main-owner', connection_id: 'conn-1' }],
        },
      });
      const result = await runTelnyxBootstrap({
        fetchImpl: mock.fetchImpl, basePath: BASE, apiKey: API_KEY,
        deploymentName: 'cc-main', baseUrl: 'https://cc.example.com',
        pickedNumber: { phone_number: '+141****0134' },
        log: () => {},
      });
      assert.strictEqual(result.phoneNumber, '+141****0134');
      // MUST NOT have re-purchased — that would be a second charge for a
      // number we already own (and Telnyx would reject the order anyway).
      assert.ok(!mock.state.callLog.some((c) => c.method === 'POST' && c.url.endsWith('/v2/number_orders')),
        'must not create a new number order for an already-owned number');
      // MUST have assigned it to the Default Call Flow's voice app via PATCH.
      const patchCall = mock.state.callLog.find((c) => c.method === 'PATCH' && c.url.endsWith('/v2/phone_numbers/pn-existing'));
      assert.ok(patchCall, 'expected a PATCH assigning the already-owned number to the voice app');
      const patchBody = JSON.parse(patchCall.body);
      assert.strictEqual(patchBody.connection_id, result.defaultFlowVoiceAppId);
    });
  });
});
