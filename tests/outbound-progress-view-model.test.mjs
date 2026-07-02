import assert from "node:assert/strict";
import test from "node:test";

import { campaignContactProgress, campaignInventoryDisplayState } from "../lib/outbound-dialer/progress-view-model.js";

test("retryable failed attempts remain callable in campaign progress", () => {
  const campaign = { id: "campaign-1", status: "running", contact_list_id: "list-1", metadata: {} };
  const contactLists = [{ id: "list-1", record_count: 10, valid_phone_count: 10 }];
  const executionDebug = {
    summary: {
      processed_records: 10,
      completed_records: 5,
      active_now: 0,
      dialing_now: 0,
    },
    recent_attempts: [
      { id: "a1", contact_record_id: "r1", status: "failed", metadata: { retry_eligible: true, next_retry_at: "2026-05-18T02:12:20.041Z" } },
      { id: "a2", contact_record_id: "r2", status: "failed", metadata: { retry_eligible: true, next_retry_at: "2026-05-18T02:12:08.888Z" } },
      { id: "a3", contact_record_id: "r3", status: "failed", metadata: { retry_eligible: true, next_retry_at: "2026-05-18T02:12:20.044Z" } },
      { id: "a4", contact_record_id: "r4", status: "failed", metadata: { retry_eligible: true, next_retry_at: "2026-05-18T02:12:20.654Z" } },
      { id: "a5", contact_record_id: "r5", status: "failed", metadata: { retry_eligible: true, next_retry_at: "2026-05-18T02:12:20.833Z" } },
    ],
  };

  const progress = campaignContactProgress(campaign, contactLists, executionDebug);

  assert.deepEqual(progress, {
    total: 10,
    completed: 5,
    remaining: 5,
    progress: 50,
    retryable: 5,
    source: "execution ledger",
  });
  assert.equal(campaignInventoryDisplayState(campaign, contactLists, executionDebug), "running");
});

test("retryable failed attempts remain callable when API payload is flattened", () => {
  const campaign = { id: "campaign-1", status: "running", contact_list_id: "list-1", metadata: {} };
  const contactLists = [{ id: "list-1", record_count: 3, valid_phone_count: 3 }];
  const executionDebug = {
    summary: {
      processed_records: 3,
      completed_records: 1,
      active_now: 0,
      dialing_now: 0,
    },
    recent_attempts: [
      { id: "a1", contact_record_id: "r1", status: "failed", retry_eligible: true },
      { id: "a2", contact_record_id: "r2", status: "failed", retry_eligible: "true" },
      { id: "a3", contact_record_id: "r3", status: "completed", retry_eligible: false },
    ],
  };

  const progress = campaignContactProgress(campaign, contactLists, executionDebug);

  assert.equal(progress.completed, 1);
  assert.equal(progress.remaining, 2);
  assert.equal(progress.retryable, 2);
  assert.equal(campaignInventoryDisplayState(campaign, contactLists, executionDebug), "running");
});

test("campaign inventory shows stopped when runtime progress is truly exhausted", () => {
  const campaign = { id: "campaign-1", status: "running", contact_list_id: "list-1", metadata: { execution_state: "running" } };
  const contactLists = [{ id: "list-1", record_count: 10 }];
  const executionDebug = {
    summary: {
      processed_records: 10,
      completed_records: 10,
      active_now: 0,
      dialing_now: 0,
    },
    recent_attempts: [],
  };

  assert.equal(campaignInventoryDisplayState(campaign, contactLists, executionDebug), "stopped");
});
