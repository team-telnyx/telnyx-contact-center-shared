import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GLOBAL_MAX_ATTEMPTS,
  normalizeGlobalMaxAttempts,
  normalizeAttemptCount,
  normalizeCampaignMaxAttempts,
  normalizeAttemptRules,
  normalizeAttemptControlLimits,
} from '../lib/outbound-dialer/attempt-limits.js';

test('normalizeGlobalMaxAttempts defaults to 5 and clamps to a safe positive range', () => {
  assert.equal(DEFAULT_GLOBAL_MAX_ATTEMPTS, 5);
  assert.equal(normalizeGlobalMaxAttempts(undefined), 5);
  assert.equal(normalizeGlobalMaxAttempts(-10), 5);
  assert.equal(normalizeGlobalMaxAttempts(0), 5);
  assert.equal(normalizeGlobalMaxAttempts(7), 7);
  assert.equal(normalizeGlobalMaxAttempts(1000), 100);
});

test('normalizeAttemptCount clamps attempt controls to 0..global max attempts', () => {
  assert.equal(normalizeAttemptCount(-3, 2, 5), 0);
  assert.equal(normalizeAttemptCount(6, 2, 5), 5);
  assert.equal(normalizeAttemptCount('', 2, 5), 2);
  assert.equal(normalizeAttemptCount('4', 2, 5), 4);
});

test('normalizeCampaignMaxAttempts follows the configured global ceiling', () => {
  assert.equal(normalizeCampaignMaxAttempts(8, 4, 10), 8);
  assert.equal(normalizeCampaignMaxAttempts(8, 4, 5), 5);
  assert.equal(normalizeCampaignMaxAttempts(undefined, 4, 3), 3);
  assert.equal(normalizeCampaignMaxAttempts(0, 4, 10), 1);
});

test('normalizeAttemptRules clamps recall rule attempts and keeps delay non-negative', () => {
  const rules = normalizeAttemptRules([
    { outcome: 'busy', attempts: 6, minutes_between_attempts: -2 },
    { outcome: 'no_answer', attempts: -3, minutesBetweenAttempts: 10 },
  ], 5);

  assert.deepEqual(rules, [
    { outcome: 'busy', attempts: 5, minutes_between_attempts: 0 },
    { outcome: 'no_answer', attempts: 0, minutes_between_attempts: 10 },
  ]);
});

test('normalizeAttemptControlLimits clamps contact, number, recall, and phone-type rules', () => {
  const normalized = normalizeAttemptControlLimits({
    max_attempts_per_contact: 9,
    max_attempts_per_number: -4,
    recall_rules: [{ outcome: 'busy', attempts: 8, minutes_between_attempts: 5 }],
    phone_type_rules: [{ phone_type: 'mobile', rules: [{ outcome: 'busy', attempts: -1, minutes_between_attempts: -5 }] }],
  }, 6);

  assert.equal(normalized.max_attempts_per_contact, 6);
  assert.equal(normalized.max_attempts_per_number, 0);
  assert.equal(normalized.recall_rules[0].attempts, 6);
  assert.equal(normalized.phone_type_rules[0].rules[0].attempts, 0);
  assert.equal(normalized.phone_type_rules[0].rules[0].minutes_between_attempts, 0);
});
