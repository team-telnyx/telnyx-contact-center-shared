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
    if (sql.includes('SET status = $1') && sql.includes('outbound_attempt_ledger')) {
      return { rows: [{ id: 'l2', status: 'dialing' }] };
    }
    if (sql.includes('lease_expires_at = NULL')) {
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

test('finalizeAgentlessAttemptByWebhook mapuje call.answered -> answered', async () => {
  const poolAnswered = createMockPool(async (sql) => {
    if (sql.includes('WHERE metadata->>\'call_control_id\'')) {
      return { rows: [{ id: 'l3', campaign_id: 'camp3', status: 'dialing' }] };
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
});

test('finalizeAgentlessAttemptByWebhook mapuje retryable hangup (busy) -> failed + retry metadata', async () => {
  const captured = { terminalStatus: null, metadata: null };
  const poolBusy = createMockPool(async (sql, params) => {
    if (sql.includes('WHERE metadata->>\'call_control_id\'')) {
      return { rows: [{ id: 'l4', campaign_id: 'camp4', status: 'answered' }] };
    }
    if (sql.includes('FROM outbound_campaigns')) {
      return { rows: [{ retry_policy: { minDelayHours: 2 } }] };
    }
    if (sql.includes('lease_expires_at = NULL')) {
      captured.terminalStatus = params[0];
      captured.metadata = JSON.parse(params[1]);
      return { rows: [{ id: 'l4', status: params[0] }] };
    }
    throw new Error(`Unexpected SQL(busy): ${sql}`);
  });

  const result = await finalizeAgentlessAttemptByWebhook(poolBusy, {
    callControlId: 'cc-2',
    eventType: 'call.hangup',
    hangupCause: 'user_busy',
  });

  assert.equal(result.status, 'failed');
  assert.equal(captured.terminalStatus, 'failed');
  assert.equal(captured.metadata.retry_eligible, true);
  assert.equal(captured.metadata.retry_after_seconds, 7200);
  assert.equal(captured.metadata.reason_code, 'user_busy');
  assert.ok(typeof captured.metadata.next_retry_at === 'string');
});

test('finalizeAgentlessAttemptByWebhook mapuje cancelled hangup -> cancelled bez retry', async () => {
  const captured = { terminalStatus: null, metadata: null };
  const poolCancelled = createMockPool(async (sql, params) => {
    if (sql.includes('WHERE metadata->>\'call_control_id\'')) {
      return { rows: [{ id: 'l5', campaign_id: 'camp5', status: 'answered' }] };
    }
    if (sql.includes('FROM outbound_campaigns')) {
      return { rows: [{ retry_policy: { minDelayHours: 1 } }] };
    }
    if (sql.includes('lease_expires_at = NULL')) {
      captured.terminalStatus = params[0];
      captured.metadata = JSON.parse(params[1]);
      return { rows: [{ id: 'l5', status: params[0] }] };
    }
    throw new Error(`Unexpected SQL(cancelled): ${sql}`);
  });

  const result = await finalizeAgentlessAttemptByWebhook(poolCancelled, {
    callControlId: 'cc-3',
    eventType: 'call.hangup',
    hangupCause: 'call_rejected',
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(captured.terminalStatus, 'cancelled');
  assert.equal(captured.metadata.retry_eligible, false);
  assert.equal(captured.metadata.next_retry_at, null);
  assert.equal(captured.metadata.reason_code, 'call_rejected');
});

test('idempotency: duplicate call.hangup na terminalnym ledgerze nie robi update', async () => {
  const queries = [];
  const pool = createMockPool(async (sql) => {
    queries.push(sql);
    if (sql.includes("status IN ('dialing', 'answered', 'claimed')")) {
      return { rows: [] };
    }
    if (sql.includes("FROM outbound_attempt_ledger") && !sql.includes("status IN ('dialing', 'answered', 'claimed')")) {
      return { rows: [{ id: 'l6', status: 'completed', metadata: { foo: 'bar' } }] };
    }
    throw new Error(`Unexpected SQL(duplicate-hangup): ${sql}`);
  });

  const result = await finalizeAgentlessAttemptByWebhook(pool, {
    callControlId: 'cc-4',
    eventType: 'call.hangup',
    hangupCause: 'normal_clearing',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.metadata.foo, 'bar');
  assert.equal(result.metadata.ignored_reason, 'already_terminal');
  assert.ok(typeof result.metadata.ignored_at === 'string');
  assert.equal(queries.some((q) => q.includes('lease_expires_at = NULL')), false);
});

test('ordering: out-of-order call.answered po terminalnym hangup jest ignorowane', async () => {
  const queries = [];
  const pool = createMockPool(async (sql) => {
    queries.push(sql);
    if (sql.includes("status IN ('dialing', 'answered', 'claimed')")) {
      return { rows: [] };
    }
    if (sql.includes("FROM outbound_attempt_ledger") && !sql.includes("status IN ('dialing', 'answered', 'claimed')")) {
      return { rows: [{ id: 'l7', status: 'failed', metadata: { reason_code: 'user_busy' } }] };
    }
    throw new Error(`Unexpected SQL(out-of-order): ${sql}`);
  });

  const result = await finalizeAgentlessAttemptByWebhook(pool, {
    callControlId: 'cc-5',
    eventType: 'call.answered',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.metadata.reason_code, 'user_busy');
  assert.equal(result.metadata.ignored_webhook_event, 'call.answered');
  assert.equal(queries.some((q) => q.includes("SET status = 'answered'")), false);
});

test('event_id dedupe: ten sam eventId nie wykonuje drugiego update', async () => {
  const queries = [];
  const pool = createMockPool(async (sql) => {
    queries.push(sql);
    if (sql.includes("status IN ('dialing', 'answered', 'claimed')")) {
      return { rows: [{ id: 'l8', status: 'answered', metadata: { processed_event_ids: ['evt-123'] } }] };
    }
    if (sql.includes("SET status = 'answered'")) {
      return { rows: [{ id: 'l8', status: 'answered' }] };
    }
    throw new Error(`Unexpected SQL(event-id-dedupe): ${sql}`);
  });

  const result = await finalizeAgentlessAttemptByWebhook(pool, {
    callControlId: 'cc-6',
    eventType: 'call.answered',
    eventId: 'evt-123',
  });

  assert.equal(result.status, 'answered');
  assert.equal(result.metadata.ignored_reason, 'duplicate_event_id');
  assert.equal(result.metadata.ignored_event_id, 'evt-123');
  assert.equal(queries.some((q) => q.includes("SET status = 'answered'")), false);
});
