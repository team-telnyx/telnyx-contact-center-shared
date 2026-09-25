// No database or provider I/O: exercise the real transaction handler with a
// recording SQL boundary and the real WhatsApp payload policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as policy from '../lib/whatsapp/policy.mjs';
import { loadRoute } from './helpers/route-harness.mjs';
import { authzGuardStub, USERS } from './helpers/authz-harness.mjs';

async function fixture(overrides = {}) {
  const statements = [], journals = [], sagas = [];
  const thread = { number_id: 'number', phone_number: '+12025550100', customer_address: '+12025550101',
    messaging_profile_id: 'profile', sending_enabled: true, last_inbound_at: new Date().toISOString(), ...overrides };
  const tx = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.startsWith('SELECT t.*')) return { rows: [thread] };
    assert.match(sql, /^INSERT INTO cc_whatsapp_messages/);
    return { rows: [] };
  } };
  const store = await loadRoute('lib/whatsapp/store.mjs', {
    'node:crypto': crypto,
    './policy.mjs': policy,
    './provider.mjs': { whatsappError: policy.whatsappError },
    './webhook-url.mjs': { whatsappWebhookUrlOrNull: () => null },
    '../acd/text-lifecycle.mjs': { appendTextMessage: async (_tx, data) => {
      journals.push(data); return { id: 'message', body: data.body };
    } },
    '../acd/saga-engine.mjs': { defineSaga() {}, startSaga: async (_tx, data) => {
      sagas.push(data); return { sagaId: 'saga' };
    } },
  });
  const send = (contactCards) => store.sendAgentWhatsAppInTransaction(tx, {
    work: { id: 'work', conversation_id: 'conversation' }, agentId: 'agent', commandId: 'command',
    body: '', data: { contactCards },
  });
  return { send, statements, journals, sagas };
}

test('device cards use the existing durable outbound journal without importing CRM contacts', async () => {
  const f = await fixture();
  const result = await f.send([{ display_name: 'Ada Example', mobile: '+12025550102',
    email_address_1: 'ada@example.test', notes: 'private', identifier: 'device-id' }]);
  assert.equal(result.status, 'queued');
  assert.equal(result.message.delivery.kind, 'contacts');
  assert.equal(f.journals.length, 1);
  assert.equal(f.journals[0].clientId, 'command');
  assert.equal(f.sagas.length, 1);
  const payload = f.sagas[0].data.payload;
  assert.equal(payload.whatsapp_message.type, 'contacts');
  assert.equal(payload.whatsapp_message.contacts[0].name.formatted_name, 'Ada Example');
  assert.equal(payload.whatsapp_message.contacts[0].phones[0].phone, '+12025550102');
  assert.ok(!JSON.stringify(payload).includes('private'));
  assert.ok(!JSON.stringify(payload).includes('device-id'));
  assert.equal(f.statements.length, 2);
  const content = JSON.parse(f.statements[1].values[3]);
  assert.deepEqual(content.contacts[0].phones, ['+12025550102']);
  assert.equal(content.contacts[0].name, 'Ada Example');
});

for (const [name, state, cards] of [
  ['closed service window', { last_inbound_at: '2020-01-01' }, [{ display_name: 'Ada' }]],
  ['paused number', { sending_enabled: false }, [{ display_name: 'Ada' }]],
  ['missing messaging profile', { messaging_profile_id: null }, [{ display_name: 'Ada' }]],
  ['too many contacts', {}, Array.from({ length: 6 }, () => ({ display_name: 'Ada' }))],
  ['invalid field', {}, [{ display_name: { bad: true } }]],
]) {
  test(`device cards reject ${name} before writing a message or saga`, async () => {
    const f = await fixture(state);
    await assert.rejects(f.send(cards));
    assert.equal(f.journals.length, 0);
    assert.equal(f.sagas.length, 0);
    assert.equal(f.statements.length, 1);
  });
}

test('Pexels route uses the shared agent guard and retains bounded proxy search', async () => {
  const queries = [];
  const deps = {
    '@/lib/authz/guard': authzGuardStub({ user: USERS.agent }),
    '@/lib/pexels.mjs': { pexelsConfigured: () => true, pexelsSearch: async (query) => {
      queries.push(query); return { photos: [], totalResults: 0, page: 1, perPage: 25 };
    } },
  };
  const route = await loadRoute('app/api/contact-center/media/pexels/route.js', deps);
  const request = new Request('https://cc.example/api/contact-center/media/pexels?query=office&perPage=25', {
    headers: { Authorization: 'Bearer test-fixture' },
  });
  const result = await route.GET(request);
  assert.equal(result.status, 200);
  assert.equal(queries[0].perPage, '25');
  assert.equal(queries[0].query, 'office');
  const anonymous = await loadRoute('app/api/contact-center/media/pexels/route.js', {
    ...deps, '@/lib/authz/guard': authzGuardStub({ user: null }),
  });
  assert.equal((await anonymous.GET(request)).status, 401);
  assert.equal(queries.length, 1);
});
