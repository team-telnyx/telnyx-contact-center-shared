import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcileDerivedSlots } from "../lib/agent-assist/derived-slot-reconciliation.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Codex review (PR #1387, P1): a completion synthesized by copying another
// slot's value (currently only pickup_facility <- caller_facility, gated on
// pickup_same_as_requesting_facility) has no relationship to its source
// unless something reconciles it whenever either premise changes. These
// tests exercise reconcileDerivedSlots' decision logic against a fake
// Postgres client, not just its source text.
//
// Codex review (PR #1388, P1): an earlier optimistic-versioning +
// data-modifying-CTE design turned out to be unsound - Postgres executes a
// CTE's data-modifying statement unconditionally, so its effects are NOT
// undone just because the outer query's own WHERE clause later matches zero
// rows. Replaced with real row-level locking.
//
// Codex review (PR #1388, P2, round 2): locking every derived row up front
// - even ones needing no change - both wasted a lock and needlessly widened
// a real deadlock window against callers with the opposite lock order
// (item/[id]/complete/route.js locks item-then-session;
// slot/[name]/route.js locks session-then-item; this codebase has no single
// consistent order across them). Locking is now deferred until a row is
// actually about to be written: a plain, non-locking read decides WHETHER
// anything needs to change, and only a row that does gets locked (both
// tables, right before the write, re-verified against the now-authoritative
// locked state in case it changed in the meantime).
//
// A synchronous fake client can't meaningfully simulate Postgres's actual
// blocking/wait semantics for concurrent transactions, so the concurrency
// guarantee itself is verified structurally (the queries contain the
// expected FOR UPDATE clauses, in the expected place) rather than by
// simulating a real race - the decision-logic and no-op-never-locks tests
// below cover the rest of the behavior.

function makeFakeClient({ slotsFilled, derivedItems = [] }) {
  const state = {
    slotsFilled: { ...slotsFilled },
    // item_id -> { slot_name, derived_from_slot, status, extracted_value }
    items: new Map(derivedItems.map((r) => [r.item_id, { ...r }])),
  };
  const queries = [];
  return {
    state,
    queries,
    async query(sql, params = []) {
      queries.push(sql);
      // Order matters: the locking session-read's SQL text is a superset of
      // the plain session-read's, so check the more specific one first.
      if (sql.includes("SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1 FOR UPDATE")) {
        return { rows: [{ slots_filled: { ...state.slotsFilled } }] };
      }
      if (sql.includes("SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1")) {
        return { rows: [{ slots_filled: { ...state.slotsFilled } }] };
      }
      if (sql.includes("JOIN aa_workflow_items i ON i.id = ist.item_id")) {
        const rows = [];
        for (const [item_id, row] of state.items) {
          if (row.derived_from_slot != null && row.status === "completed") {
            rows.push({ item_id, slot_name: row.slot_name, derived_from_slot: row.derived_from_slot });
          }
        }
        return { rows };
      }
      if (sql.includes("SELECT status, derived_from_slot FROM aa_workflow_item_status")) {
        const [, itemId] = params;
        const row = state.items.get(itemId);
        if (!row) return { rows: [] };
        return { rows: [{ status: row.status, derived_from_slot: row.derived_from_slot }] };
      }
      if (sql.includes("SET status = 'pending'")) {
        const [, itemId] = params;
        const row = state.items.get(itemId);
        row.status = "pending";
        row.extracted_value = null;
        row.derived_from_slot = null;
        return { rowCount: 1 };
      }
      if (sql.includes("slots_filled = slots_filled - 'pickup_facility'")) {
        delete state.slotsFilled.pickup_facility;
        return { rowCount: 1 };
      }
      if (sql.includes("SET extracted_value = $1, updated_at = NOW()")) {
        const [newValue, , itemId] = params;
        state.items.get(itemId).extracted_value = newValue;
        return { rowCount: 1 };
      }
      if (sql.includes("jsonb_build_object('pickup_facility'")) {
        const [newValue] = params;
        state.slotsFilled.pickup_facility = newValue;
        return { rowCount: 1 };
      }
      throw new Error(`Unmocked query: ${sql.slice(0, 100)}`);
    },
  };
}

test("no-op when there are no derived rows at all", async () => {
  const client = makeFakeClient({ slotsFilled: { caller_facility: "Sutter General" } });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.deepEqual(updates, []);
});

test("no-op when the derived value already matches the current source (nothing drifted)", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Sutter General",
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.deepEqual(updates, []);
  assert.equal(client.state.slotsFilled.pickup_facility, "Sutter General");
});

// Codex review (PR #1388, P2, round 2): the whole point of deferring
// locking is that a no-op row is never locked at all - verify that
// directly, not just that the outcome is correct.
test("a row that needs no change is never locked at all", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Sutter General",
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  await reconcileDerivedSlots({ client, sessionId: "s1" });
  const lockQueries = client.queries.filter((q) => q.includes("FOR UPDATE"));
  assert.deepEqual(lockQueries, [], "a no-op row must never trigger a lock");
});

test("resyncs pickup_facility when the premise still holds but caller_facility drifted to a new value", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Brookfield Medical Center",
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General", // stale, pre-correction copy
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "completed");
  assert.equal(updates[0].extracted_value, "Brookfield Medical Center");
  assert.equal(updates[0].cleared_reason, "pickup_facility_copy_resynced");
  assert.equal(client.state.slotsFilled.pickup_facility, "Brookfield Medical Center");
  assert.equal(client.state.items.get("item-pickup").extracted_value, "Brookfield Medical Center");
});

test("reopens pickup_facility when pickup_same_as_requesting_facility is corrected to false", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Sutter General",
      pickup_same_as_requesting_facility: false, // corrected true -> false
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "pending");
  assert.equal(updates[0].extracted_value, null);
  assert.equal(updates[0].cleared_reason, "pickup_facility_copy_premise_changed");
  assert.equal(client.state.slotsFilled.pickup_facility, undefined);
  assert.equal(client.state.items.get("item-pickup").status, "pending");
  assert.equal(client.state.items.get("item-pickup").derived_from_slot, null);
});

test("reopens pickup_facility when caller_facility itself gets cleared, even if the boolean is still true", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "",
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cleared_reason, "pickup_facility_copy_premise_changed");
});

test("treats a string 'yes' the same as boolean true for the premise (matches the Sixth guard's own truthy check)", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Brookfield Medical Center",
      pickup_same_as_requesting_facility: "yes",
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cleared_reason, "pickup_facility_copy_resynced");
});

test("ignores a derived row for any relationship other than pickup_facility <- caller_facility", async () => {
  const client = makeFakeClient({
    slotsFilled: { some_other_slot: "value", caller_facility: "Sutter General" },
    derivedItems: [
      { item_id: "item-other", slot_name: "some_other_slot", derived_from_slot: "some_source_slot", status: "completed", extracted_value: "value" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.deepEqual(updates, []);
});

// Codex review (PR #1388, P2): a writer that changes the item_status row
// out from under this pass (the skip route sets status = 'skipped'
// unconditionally) must never have its row silently reopened/resynced.
// status = 'completed' applied in the plain SELECT keeps a skipped row out
// of consideration at all, in EITHER branch.

test("a skipped item (status no longer 'completed') is never selected as a derived row in the first place", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Brookfield Medical Center - Downtown",
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "skipped", extracted_value: "Sutter General" },
    ],
  });
  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.deepEqual(updates, []);
  assert.equal(client.state.slotsFilled.pickup_facility, "Sutter General", "must not resync onto a skipped item");
  assert.equal(client.state.items.get("item-pickup").status, "skipped", "the skip must survive untouched");
});

// Codex review (PR #1388, P2, round 2): even after the plain read decides a
// write is needed, the row is re-verified against the LOCKED state before
// actually writing - it may have changed in the (brief) time between the
// plain read and acquiring the locks.

test("re-verifies against the locked state and backs off if the row was skipped between the plain read and the lock", async () => {
  const client = makeFakeClient({
    slotsFilled: {
      caller_facility: "Brookfield Medical Center - Downtown", // drifted, would normally trigger a resync
      pickup_same_as_requesting_facility: true,
      pickup_facility: "Sutter General",
    },
    derivedItems: [
      { item_id: "item-pickup", slot_name: "pickup_facility", derived_from_slot: "caller_facility", status: "completed", extracted_value: "Sutter General" },
    ],
  });
  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    if (sql.includes("SELECT status, derived_from_slot FROM aa_workflow_item_status")) {
      // Simulates the skip route landing between the plain read and this lock.
      client.state.items.get("item-pickup").status = "skipped";
    }
    return originalQuery(sql, params);
  };

  const { updates } = await reconcileDerivedSlots({ client, sessionId: "s1" });
  assert.deepEqual(updates, []);
  assert.equal(client.state.slotsFilled.pickup_facility, "Sutter General", "must not have resynced onto the now-skipped item");
});

// Codex review (PR #1388, P1): locking sidesteps the unsound CTE-atomicity
// question. Verified structurally: the initial reads are plain (no lock),
// and only the per-row check-then-write path locks anything.

test("the initial session and derived-rows reads are plain (not locking)", async () => {
  const source = await read("../lib/agent-assist/derived-slot-reconciliation.mjs");
  assert.match(source, /const \{ rows: \[session\] \} = await client\.query\(\s*\n\s*`SELECT slots_filled FROM aa_workflow_sessions WHERE id = \$1`,/);
  const joinIdx = source.indexOf("JOIN aa_workflow_items i ON i.id = ist.item_id");
  assert.ok(joinIdx > -1);
  const derivedBlock = source.slice(joinIdx, joinIdx + 200);
  assert.doesNotMatch(derivedBlock, /FOR UPDATE/);
});

test("a needed write locks both the item_status row and the session row, in that order, right before writing", async () => {
  const source = await read("../lib/agent-assist/derived-slot-reconciliation.mjs");
  const actionIdx = source.indexOf("if (!action) continue;");
  const freshActionIdx = source.indexOf("if (!freshAction) continue;", actionIdx);
  assert.ok(actionIdx > -1 && freshActionIdx > actionIdx);
  const block = source.slice(actionIdx, freshActionIdx);
  const itemLockIdx = block.indexOf("SELECT status, derived_from_slot FROM aa_workflow_item_status");
  const sessionLockIdx = block.indexOf("SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1 FOR UPDATE");
  assert.ok(itemLockIdx > -1 && sessionLockIdx > itemLockIdx, "item lock must be acquired before the session lock");
  assert.match(block, /FOR UPDATE`,\s*\n\s*\[sessionId, row\.item_id\]/);
});

test("does not use a data-modifying CTE for the writes (regression, Codex P1 - that shape is unsound: Postgres applies a CTE's write unconditionally regardless of the outer query's own row match)", async () => {
  const source = await read("../lib/agent-assist/derived-slot-reconciliation.mjs");
  assert.doesNotMatch(source, /WITH item_claim AS/);
});
