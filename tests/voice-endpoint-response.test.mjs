import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVoiceEndpointResponse as decode } from '../lib/telephony/endpoint-response.mjs';

test('voice endpoints decode valid JSON responses', async () => {
  const body = { generation: '3', endpoints: [] };
  assert.deepEqual(await decode(Response.json(body)), body);
});
for (const [status, body] of [[500, ''], [502, '<html>Bad gateway</html>'], [503, '{']]) {
  test(`voice endpoints retain HTTP ${status} for non-JSON error responses`, async () => {
    await assert.rejects(decode(new Response(body, { status })), { status, message: `Voice service is temporarily unavailable (HTTP ${status}). Please retry.` });
  });
}
test('voice endpoints preserve actionable API errors', async () => {
  await assert.rejects(decode(Response.json({ error: 'Sign in again to register this device.' }, { status: 409 })), { status: 409, message: 'Sign in again to register this device.' });
});
for (const body of ['', 'null', '[]', 'true']) {
  test(`voice endpoints reject invalid successful response ${JSON.stringify(body)}`, async () => {
    await assert.rejects(decode(new Response(body)), { status: 200, message: 'Voice service returned an invalid response. Please retry.' });
  });
}
