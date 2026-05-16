import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeE164Like,
  pickContactPhoneNumber,
  executeAgentlessAttempt,
  finalizeAgentlessAttemptByWebhook,
} from '../lib/outbound-dialer/execution.js';

function createMockPool(handler) {
  return {
    async query(sql, params) {
      return handler(String(sql), params || []);
    },
  };
}

test('normalizeE164Like normalizuje poprawnie i odrzuca śmieci', () => {
  assert.equal(normalizeE164Like('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizeE164Like('48 600 700 800'), '+48600700800');
  assert.equal(normalizeE164Like('abc'), null);
  assert.equal(normalizeE164Like(''), null);
});

test('pickContactPhoneNumber preferuje contact_methods, fallbackuje do row_data', () => {
  const fromMethods = pickContactPhoneNumber({
    contact_methods: {
      number: { primary: '+48 600 111 222' },
    },
    row_data: { phone_number: '+48 600 999 888' },
  });
  assert.equal(fromMethods, '+48600111222');

  const fallback = pickContactPhoneNumber({
    contact_methods: {},
    row_data: { mobile: '600-555-444' },
  });
  assert.equal(fallback, '+600555444');
});

test('executeAgentlessAttempt -> suppressed gdy brak callable number', async () => {
  const queries = [];
  const pool = createMockPool(async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM outbound_contact_records')) {
      return { rows: [{ id: 'c1', row_data: {}, contact_methods: {} }] };
    }
    if (sql.includes('UPDATE outbound_attempt_ledger')) {
      return { rows: [{ id: 'l1', status: 'suppressed' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await executeAgentlessAttempt(
    pool,
    { id: 'camp1', handler_type: 'agentless' },
    { id: 'l1', contact_record_id: 'c1', run_id: 'r1' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_callable_number');
  assert.ok(queries.some((q) => q.includes('FROM outbound_contact_records')));
});

test('executeAgentlessAttempt -> failed gdy Telnyx zwraca błąd', async () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.TELNYX_API_KEY;
  const originalFrom = process.env.TELNYX_MAIN_FROM_NUMBER;

  process.env.TELNYX_API_KEY = 'test_key';
  process.env.TELNYX_MAIN_FROM_NUMBER = '+15551230000';

  global.fetch = async () => ({
    ok: false,
    status: 422,
    async text() {
      return 'invalid destination';
    },
  });

  const pool = createMockPool(async (sql) => {
    if (sql.includes('FROM outbound_contact_records')) {
      return {
        rows: [{ id: 'c2', row_data: { phone_number: '+48600123456' }, contact_methods: {} }],
      };
    }
    if (sql.includes("SET status = $1") && sql.includes('outbound_attempt_ledger')) {
      return { rows: [{ id: 'l2', status: 'dialing' }] };
    }
    if (sql.includes('SET status = $1,') && sql.includes('lease_expires_at = NULL')) {
      return { rows: [{ id: 'l2', status: 'failed' }] };
    }
    if (sql.includes('SET status = $1') && sql.includes('lease_expires_at = NULL')) {
      return { rows: [{ id: 'l2', status: 'failed' }] };
    }
    if (sql.includes('UPDATE outbound_attempt_ledger')) {
      return { rows: [{ id: 'l2', status: 'failed' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await executeAgentlessAttempt(
    pool,
    { id: 'camp2', handler_type: 'agentless' },
    { id: 'l2', contact_record_id: 'c2', run_id: 'r2' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'telnyx_dial_failed');
  assert.equal(result.status, 422);

  global.fetch = originalFetch;
  process.env.TELNYX_API_KEY = originalApiKey;
  process.env.TELNYX_MAIN_FROM_NUMBER = originalFrom;
});

test('finalizeAgentlessAttemptByWebhook mapuje call.answered i call.hangup', async () => {
  const poolAnswered = createMockPool(async (sql) => {
    if (sql.includes('WHERE metadata->>\'call_control_id\'')) {
      return { rows: [{ id: 'l3', status: 'dialing' }] };
    }
    if (sql.includes("SET status = 'answered'")) {
      return { rows: [{ id: 'l3', status: 'answered' }] };
    }
    throw new Error(`Unexpected SQL(answered): ${sql}`);
  });

  const answered = await finalizeAgentlessAttemptByWebhook(poolAnswered, {
    callControlId: 'cc-1',
    eventType: 'call.answered',
  });
  assert.equal(answered.status, 'answered');

  const poolHangup = createMockPool(async (sql) => {
    if (sql.includes('WHERE metadata->>\'call_control_id\'')) {
      return { rows: [{ id: 'l4', status: 'answered' }] };
    }
    if (sql.includes('SET status = $1') && sql.includes('lease_expires_at = NULL')) {
      return { rows: [{ id: 'l4', status: 'completed' }] };
    }
    throw new Error(`Unexpected SQL(hangup): ${sql}`);
  });

  const completed = await finalizeAgentlessAttemptByWebhook(poolHangup, {
    callControlId: 'cc-2',
    eventType: 'call.hangup',
    hangupCause: 'normal_clearing',
  });
  assert.equal(completed.status, 'completed');
});
