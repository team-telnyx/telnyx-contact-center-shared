import assert from 'node:assert/strict';
import test from 'node:test';
import { createFcmSender, fcmAlertMessage, fcmConfiguration, fcmFailure, FCM_SCOPE } from '../lib/mobile/fcm.mjs';
import { mobileAlertPayload, mobileAlertSenders } from '../lib/mobile/alerts.mjs';
import { sanitizeLogPayload } from '../lib/logger/redaction.mjs';

const now = Date.parse('2026-10-13T10:00:00Z');
const config = { projectId: 'example-firebase-project', credentials: { client_email: 'test@example.test', private_key: 'test-key' } };
const notification = {
  fcm_token: 'opaque-FCM:registration_123', channel: 'sms', customer_name: 'Test customer',
  queue_name: 'Support', work_item_id: 'interaction-1', event_id: 42,
  expires_at: new Date(now + 300000).toISOString(),
};

test('FCM sends a data-only HTTP v1 request with APNs display text, correct scope and offer TTL', async () => {
  let authCreations = 0, requests = 0;
  const send = createFcmSender(config, {
    now: () => now,
    authFactory: options => {
      authCreations++;
      assert.deepEqual(options.scopes, [FCM_SCOPE]);
      assert.equal(options.clientOptions.eagerRefreshThresholdMillis, 60000);
      return { getAccessToken: async () => 'test-oauth-access-token' };
    },
    fetchImpl: async (url, request) => {
      requests++;
      assert.equal(url, 'https://fcm.googleapis.com/v1/projects/example-firebase-project/messages:send');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.Authorization, 'Bearer test-oauth-access-token');
      const apns = mobileAlertPayload(notification);
      assert.deepEqual(JSON.parse(request.body), { message: {
        token: notification.fcm_token, android: { priority: 'HIGH', ttl: '300s' },
        data: { title: apns.aps.alert.title, body: apns.aps.alert.body, interactionId: 'interaction-1' },
      } });
      assert.ok(request.signal instanceof AbortSignal);
      assert.doesNotMatch(request.body, /"notification"|"metadata"/);
      return new Response('{"name":"projects/test/messages/test"}', { status: 200 });
    },
  });
  assert.deepEqual(await send(notification), { status: 200 });
  await send(notification);
  assert.equal(authCreations, 1, 'reuse the GoogleAuth client and its token cache');
  assert.equal(requests, 2);
  assert.equal(fcmAlertMessage({ ...notification, expires_at: new Date(now + 75000) }, now).message.android.ttl, '75s');
  assert.ok(Object.values(fcmAlertMessage(notification, now).message.data).every(value => typeof value === 'string'));
});

test('configuration accepts escaped PEM newlines and never exposes JSON parse errors', () => {
  assert.equal(fcmConfiguration({}), null);
  const env = { FCM_PROJECT_ID: 'example-firebase-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', client_email: 'test@example.test', private_key: 'line1\\nline2',
  }) };
  assert.equal(fcmConfiguration(env).credentials.private_key, 'line1\nline2');
  for (const bad of ['secret private key not json', 'null', '{}']) {
    assert.throws(() => fcmConfiguration({ ...env, FCM_SERVICE_ACCOUNT_JSON: bad }), { message: 'Invalid FCM configuration' });
  }
  assert.throws(() => fcmConfiguration({ ...env, FCM_PROJECT_ID: '../another-project' }), /Invalid FCM configuration/);
});

const fcmError = (code, message = '') => ({ error: { message, details: [
  { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code },
] } });

test('only unregistered or token-specific invalid arguments invalidate a registration', () => {
  assert.equal(fcmFailure(404, fcmError('UNREGISTERED')).invalidToken, true);
  assert.equal(fcmFailure(400, fcmError('INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token')).invalidToken, true);
  assert.equal(fcmFailure(400, { error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] },
  ] } }).invalidToken, true);
  for (const [status, body] of [[404, {}], [400, fcmError('INVALID_ARGUMENT', 'Invalid TTL')], [403, fcmError('SENDER_ID_MISMATCH')]]) {
    assert.equal(fcmFailure(status, body).invalidToken, false);
    assert.equal(fcmFailure(status, body).retryable, false);
  }
});

test('retryable failures respect Retry-After and quota backoff', () => {
  assert.equal(fcmFailure(429, {}, null, now).retryAfterSeconds, 60);
  assert.equal(fcmFailure(503, {}, '120', now).retryAfterSeconds, 120);
  assert.equal(fcmFailure(503, {}, new Date(now + 90000).toUTCString(), now).retryAfterSeconds, 90);
  assert.equal(fcmFailure(503, {}).retryable, true);
});

test('missing configuration skips without creating an auth client or making HTTP requests', async () => {
  const unexpected = () => assert.fail('No I/O without configuration');
  const result = await createFcmSender(null, { authFactory: unexpected, fetchImpl: unexpected })(notification);
  assert.equal(result.skipped, true);
});

test('worker FCM configuration is independent of APNs and reports disabled only at initialization', () => {
  const logs = [];
  const logger = { info: event => logs.push(event), warn: event => logs.push(event) };
  assert.equal(mobileAlertSenders({}, logger).enabled, false);
  assert.deepEqual(logs, ['fcm_alerts_disabled']);
  const env = { FCM_PROJECT_ID: 'example-firebase-project', FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', client_email: 'test@example.test', private_key: 'test',
  }), APNS_ALERT_KEY_ID: 'x', APNS_ALERT_TEAM_ID: 'x', APNS_ALERT_PRIVATE_KEY: 'x', APNS_ALERT_TOPICS: 'bad-json' };
  assert.equal(mobileAlertSenders(env, logger).enabled, true);
  assert.equal(logs.at(-1), 'apns_alerts_configuration_invalid');
});

test('OAuth, transport and provider error text never leaks into delivery diagnostics', async () => {
  const secret = notification.fcm_token;
  for (const boundary of ['auth', 'transport', 'provider']) {
    const send = createFcmSender(config, {
      now: () => now,
      authFactory: () => ({ getAccessToken: async () => { if (boundary === 'auth') throw new Error(secret); return 'oauth'; } }),
      fetchImpl: async () => {
        if (boundary === 'transport') throw new Error(secret);
        return Response.json(fcmError('INVALID_ARGUMENT', `Invalid registration token ${secret}`), { status: 400 });
      },
    });
    assert.ok(!JSON.stringify(await send(notification)).includes(secret));
  }
  const sanitized = sanitizeLogPayload({ fcmToken: secret, fcm_token: secret, FCM_SERVICE_ACCOUNT_JSON: secret, private_key: secret });
  assert.ok(!JSON.stringify(sanitized).includes(secret));
});

test('an offer that expires during OAuth renewal is never sent with TTL zero', async () => {
  let clock = now;
  const send = createFcmSender(config, {
    now: () => clock,
    authFactory: () => ({ getAccessToken: async () => { clock += 301000; return 'oauth'; } }),
    fetchImpl: async () => assert.fail('Expired offer must not be sent'),
  });
  assert.deepEqual(await send(notification), { status: 410, reason: 'ExpiredOffer' });
});
