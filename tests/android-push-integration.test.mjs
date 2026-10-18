import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, makeTxRunner } from './helpers/acd-test-db.mjs';
import { loadRoute } from './helpers/route-harness.mjs';
import * as devices from '../lib/mobile/devices.mjs';
import { mutateRefreshSession } from '../lib/auth-refresh-sessions.mjs';
import { createWorkItem } from '../lib/acd/lifecycle.mjs';
import { tryOfferAndReserve } from '../lib/acd/reservations.mjs';
import { ensureVoiceEndpointSchema, registerVoiceEndpoint, readVoiceEndpoints } from '../lib/acd/voice-endpoints.mjs';
import * as voiceEndpoints from '../lib/acd/voice-endpoints.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { drainMobileAlerts, queueMobileAlerts } from '../lib/mobile/alerts.mjs';
import { createFcmSender, fcmFailure } from '../lib/mobile/fcm.mjs';

const pool = await prepareAcdTestPool('cc_android_push_test');
const tx = makeTxRunner(pool);
after(() => pool.end());
const logger = { info() {}, error() {} };
const androidBody = (deviceId = randomUUID()) => ({
  deviceId, kind: 'android', platform: 'android', fcmToken: `FCM:${deviceId}`,
  voipToken: null, alertToken: null, name: 'Pixel 9', systemVersion: '16', appVersion: '0.1.0 (1)',
  bundleIdentifier: 'com.novumcx.telnyx', environment: 'production',
});
const provision = async id => ({ id: `test-credential-${id}`, username: `test-sip-${id}` });
async function userFixture() {
  const id = randomUUID(), authSessionId = randomUUID();
  await seedAgent(pool, id);
  await mutateRefreshSession(id, { add: { sessionId: authSessionId, refreshToken: authSessionId, expiresAt: new Date(Date.now() + 86400000).toISOString() } }, pool);
  return { id, authSessionId, roles: ['agent'] };
}
async function offerFixture({ ios = false } = {}) {
  const user = await userFixture();
  const registration = { ...devices.readRegistration(androidBody()), authSessionId: user.authSessionId };
  await devices.upsertDevice(user.id, registration, pool);
  if (ios) await devices.upsertDevice(user.id, { ...registration, deviceId: randomUUID(), kind: 'ios', platform: null, fcmToken: null, alertToken: 'a'.repeat(64) }, pool);
  const work = await createWorkItem(pool, { channel: 'voice', direction: 'inbound', actor: 'test' });
  const offer = await tx(db => tryOfferAndReserve(db, { workItemId: work.id, agentId: user.id, channel: 'voice', offerDeadlineMs: 300000, actor: 'test' }));
  assert.ok(offer);
  return { user, registration, work };
}
const alertRow = async f => (await pool.query('SELECT * FROM cc_mobile_alerts WHERE device_id=$1', [f.registration.deviceId])).rows[0];
const deviceRow = async f => (await pool.query('SELECT * FROM cc_mobile_devices WHERE device_id=$1', [f.registration.deviceId])).rows[0];
const due = async f => pool.query('UPDATE cc_mobile_alerts SET next_attempt_at=now() WHERE device_id=$1', [f.registration.deviceId]);

test('schema upgrade preserves legacy iOS records and accepts Android on repeated bootstrap', async () => {
  // Recreate the old constraints before adding any Android rows.
  const user = await userFixture();
  const old = { ...devices.readRegistration({ ...androidBody(), kind: 'ios', platform: null, fcmToken: null, voipToken: 'a'.repeat(64) }), authSessionId: user.authSessionId };
  await devices.upsertDevice(user.id, old, pool);
  await registerVoiceEndpoint(pool, user, { kind: 'ios', deviceId: old.deviceId }, provision);
  await pool.query(`ALTER TABLE cc_mobile_devices DROP CONSTRAINT cc_mobile_devices_kind_check;
    ALTER TABLE cc_mobile_devices ADD CONSTRAINT cc_mobile_devices_kind_check CHECK (kind IN ('ios','watch'));
    ALTER TABLE cc_mobile_devices DROP COLUMN platform, DROP COLUMN fcm_token;
    ALTER TABLE cc_voice_endpoints DROP CONSTRAINT cc_voice_endpoints_kind_check;
    ALTER TABLE cc_voice_endpoints ADD CONSTRAINT cc_voice_endpoints_kind_check CHECK (kind IN ('web','ios'));`);
  for (let i = 0; i < 2; i++) {
    await devices.ensureMobileDeviceSchema(pool);
    await ensureVoiceEndpointSchema(pool);
  }
  assert.equal((await devices.listDevices(user.id, pool))[0].canReceiveCalls, true);
  const body = androidBody();
  await devices.upsertDevice(user.id, devices.readRegistration(body), pool);
  const endpoint = await registerVoiceEndpoint(pool, user, { kind: 'android', deviceId: body.deviceId }, provision);
  const listed = (await readVoiceEndpoints(pool, user.id)).endpoints.find(e => e.id === endpoint.registration.id);
  assert.equal(listed.kind, 'android');
  assert.equal(listed.label, 'Android');
});

test('actual device PUT/GET/DELETE handlers accept the Android contract and enforce ownership', async () => {
  const user = await userFixture();
  const deps = {
    '@/lib/auth-server': { getAuthenticatedUser: async () => user },
    '@/lib/security-logging.mjs': { securityErrorPayload: () => ({}) },
    '@/lib/mobile/devices.mjs': { ...devices, devicesLogger: logger,
      ensureMobileDeviceSchema: () => devices.ensureMobileDeviceSchema(pool),
      upsertDevice: (id, body) => devices.upsertDevice(id, body, pool),
      listDevices: id => devices.listDevices(id, pool),
      removeDevice: (id, deviceId) => devices.removeDevice(id, deviceId, pool),
    },
  };
  const collection = await loadRoute('app/api/mobile/v1/devices/route.js', deps);
  const item = await loadRoute('app/api/mobile/v1/devices/[deviceId]/route.js', deps);
  const body = androidBody();
  const request = value => new Request('https://cc.test/api/mobile/v1/devices', { method: 'PUT', body: JSON.stringify(value) });
  assert.equal((await collection.PUT(request(body))).status, 200);
  const list = await collection.GET(new Request('https://cc.test/api/mobile/v1/devices'));
  assert.equal(list.body.devices[0].kind, 'android');
  assert.doesNotMatch(JSON.stringify(list), /FCM:|fcmToken|fcm_token/);
  assert.equal((await collection.PUT(request({ ...body, fcmToken: 123 }))).status, 400);
  assert.equal((await item.DELETE(null, { params: Promise.resolve({ deviceId: body.deviceId }) })).body.removed, true);
  assert.equal((await item.DELETE(null, { params: Promise.resolve({ deviceId: body.deviceId }) })).body.removed, false);
});

test('one committed offer reaches both iOS/APNs and Android/FCM once', async () => {
  const f = await offerFixture({ ios: true });
  const sent = [];
  const send = async n => { sent.push(['ios', n.work_item_id]); return { status: 200 }; };
  const sendFcm = async n => { sent.push(['android', n.work_item_id]); return { status: 200 }; };
  await drainMobileAlerts(pool, { send, sendFcm });
  await drainMobileAlerts(pool, { send, sendFcm });
  assert.deepEqual(sent.sort(), [['android', f.work.id], ['ios', f.work.id]]);
  assert.equal((await alertRow(f)).status, 'sent');
});

test('voice endpoint HTTP handlers register, list, select and withdraw Android', async () => {
  const user = await userFixture();
  const route = await loadRoute('app/api/contact-center/agent/voice-endpoints/route.js', {
    '@/lib/auth-server': { getAuthenticatedUser: async () => user },
    '@/lib/postgres.mjs': { getPostgresPool: () => pool },
    '@/lib/acd/voice-endpoints.mjs': voiceEndpoints,
    '@/lib/telnyx-credentials': { createTelephonyCredential: () => provision(randomUUID()) },
    env: { TELNYX_API_KEY: 'test-only', TELNYX_SIP_CONNECTION_ID: 'test-only' },
  });
  const request = (method, body, token) => new Request('https://cc.test/api/contact-center/agent/voice-endpoints', {
    method, ...(body ? { body: JSON.stringify(body) } : {}), headers: token ? { 'x-cc-endpoint-token': token } : {},
  });
  const body = androidBody();
  await devices.upsertDevice(user.id, { ...devices.readRegistration(body), authSessionId: user.authSessionId }, pool);
  const registered = await route.POST(request('POST', { kind: 'android', deviceId: body.deviceId }));
  assert.equal(registered.status, 200);
  const { id, token } = registered.body.registration;
  const endpoint = await voiceEndpoints.authenticateVoiceEndpoint(pool, user, token);
  await heartbeatAgentSession(pool, { agentId: user.id, sessionId: id, voiceEndpoint: endpoint, voiceReady: true, pushReady: true });
  assert.equal((await route.PUT(request('PUT', { endpointId: id, expectedGeneration: '0' }))).status, 200);
  await heartbeatAgentSession(pool, { agentId: user.id, sessionId: id, voiceEndpoint: endpoint, voiceReady: false, pushReady: true });
  const listed = await route.GET(request('GET', null, token));
  assert.equal(listed.body.endpoints[0].kind, 'android');
  assert.equal(listed.body.endpoints[0].availability, 'standby');
  assert.equal(listed.body.endpointId, id);
  assert.equal((await route.DELETE(request('DELETE', null, token))).status, 200);
  assert.deepEqual((await route.GET(request('GET'))).body.endpoints, []);
});

test('FCM rejection clears only the token that actually failed and stops retries', async () => {
  for (const result of [fcmFailure(404, { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }),
    fcmFailure(400, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }] } })]) {
    const f = await offerFixture();
    await drainMobileAlerts(pool, { sendFcm: async () => result });
    assert.equal((await deviceRow(f)).fcm_token, null);
    assert.equal((await alertRow(f)).status, 'discarded');
    assert.equal((await devices.listDevices(f.user.id, pool))[0].canReceiveCalls, false);
  }
  const f = await offerFixture();
  await drainMobileAlerts(pool, { sendFcm: async () => {
    await pool.query('UPDATE cc_mobile_devices SET fcm_token=$2 WHERE device_id=$1', [f.registration.deviceId, 'rotated-token']);
    return { status: 404, invalidToken: true, reason: 'FcmInvalidToken' };
  } });
  assert.equal((await deviceRow(f)).fcm_token, 'rotated-token');
});

test('retryable FCM failures back off without blocking APNs or losing token registration', async () => {
  const f = await offerFixture({ ios: true });
  let apple = 0;
  await drainMobileAlerts(pool, { send: async () => { apple++; return { status: 200 }; }, sendFcm: async () => fcmFailure(429, {}, '120') });
  assert.equal(apple, 1);
  assert.equal((await alertRow(f)).status, 'pending');
  assert.ok(new Date((await alertRow(f)).next_attempt_at).getTime() - Date.now() > 110000);
  assert.ok((await deviceRow(f)).fcm_token);
  await due(f);
  await drainMobileAlerts(pool, { sendFcm: async () => fcmFailure(503, {}) });
  assert.equal((await alertRow(f)).status, 'pending');
  await due(f);
  await drainMobileAlerts(pool, { sendFcm: async () => ({ status: 200 }) });
  assert.equal((await alertRow(f)).status, 'sent');
});

test('missing FCM config and permanent failures do not retry or block other devices', async () => {
  for (const sendFcm of [createFcmSender(null), async () => fcmFailure(403, {})]) {
    const f = await offerFixture({ ios: true });
    let apple = 0;
    await drainMobileAlerts(pool, { send: async () => { apple++; return { status: 200 }; }, sendFcm });
    assert.equal(apple, 1);
    assert.notEqual((await alertRow(f)).status, 'pending');
    assert.ok((await deviceRow(f)).fcm_token);
  }
});

for (const invalidation of ['logout', 'disabled', 'expired', 'new login', 'deleted']) {
  test(`queued FCM alert is not delivered after ${invalidation}`, async () => {
    const f = await offerFixture();
    await queueMobileAlerts(pool);
    if (invalidation === 'logout') await mutateRefreshSession(f.user.id, { revoke: f.user.authSessionId }, pool);
    if (invalidation === 'disabled') await pool.query('UPDATE users SET active=false WHERE id=$1', [f.user.id]);
    if (invalidation === 'expired') await pool.query(`UPDATE users SET refresh_tokens=jsonb_build_array(jsonb_build_object('sessionId',$2::text,'expiresAt','2000-01-01T00:00:00Z')) WHERE id=$1`, [f.user.id, f.user.authSessionId]);
    if (invalidation === 'new login') {
      await mutateRefreshSession(f.user.id, { add: { sessionId: 'new-login', refreshToken: 'new-token' } }, pool);
      await devices.upsertDevice(f.user.id, { ...f.registration, authSessionId: 'new-login' }, pool);
    }
    if (invalidation === 'deleted') await devices.removeDevice(f.user.id, f.registration.deviceId, pool);
    await drainMobileAlerts(pool, { sendFcm: async () => assert.fail('Revoked delivery') });
    assert.equal((await alertRow(f)).status, 'discarded');
  });
}
