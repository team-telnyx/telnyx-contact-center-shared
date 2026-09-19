// A completion synthesized by copying another slot's value (currently only
// the the reference workflow "pickup facility same as requesting facility" guard in
// app/api/agent-assist/workflow/analyze/route.js, which copies
// caller_facility onto pickup_facility) is marked in
// aa_workflow_item_status.derived_from_slot. That marker has no effect on
// its own — something has to notice when the premise it depends on changes
// (the source slot gets corrected, or the confirming boolean flips back to
// false) and either resync the copy or reopen it. Left unreconciled, a
// stale copied facility name can keep feeding MCP lookup and dispatch with
// the wrong physical pickup location.
//
// This runs from every path that can change either premise: the analyze
// route (spoken correction), and the manual item-complete and slot-update
// routes (an agent editing caller_facility or the boolean by hand) — see
// Codex review, PR #1387, P1: "premise-edit paths must perform the same
// invalidation atomically", not just the transcript-analyze path.
//
// Callers pass the SAME client/transaction they used for their own write,
// so this reads that write's own uncommitted state (standard read-your-own-
// writes within one Postgres transaction) and commits atomically with it.
//
// Codex review (PR #1388, P1): an earlier version tried to make the session
// (slots_filled) write and the item_status write atomic via a
// data-modifying CTE, gated with `AND EXISTS (SELECT 1 FROM item_claim)` on
// the outer UPDATE. That doesn't work: Postgres executes every CTE's
// data-modifying statement exactly once, UNCONDITIONALLY, as part of
// computing the overall statement - the CTE's write is not "undone" just
// because the outer query's own WHERE clause later matches zero rows for
// unrelated reasons (e.g. a concurrent transaction bumped slots_version in
// between). So the item_status write could still apply even when the
// session write's version guard rejected it - the exact torn-write bug
// that construction was meant to fix, just inverted. Row-level locking
// sidesteps the whole question: SELECT ... FOR UPDATE on both the session
// row and the relevant item_status row(s) blocks any other writer of
// either from proceeding until this pass releases them (commit/rollback),
// so a plain read-then-write in between is genuinely race-free - no
// optimistic version/CAS bookkeeping needed, and no risk of a partially
// applied pair.
//
// Codex review (P2): the session row is always locked first, then
// item_status - but item/[id]/complete/route.js locks item_status FIRST,
// then aa_workflow_sessions (its mcp_candidates clear), and
// slot/[name]/route.js locks them in the OPPOSITE order again. This
// codebase does not have one single consistent cross-table lock order
// today, so unconditionally locking every derived item_status row up front
// - even ones that turn out to need no change at all - both wastes a lock
// for nothing and needlessly widens a real deadlock window against
// whichever caller locks item-then-session. Locking is deferred until a
// row is actually about to be written (see below): a plain, non-locking
// read decides WHETHER a row needs reopening/resyncing, and only a row
// that does gets its own row lock, immediately before that write, holding
// it for the shortest time and only when a lock is actually needed - this
// shrinks the window from "every reconciliation call" to "only when this
// exact row is concurrently being written by two different transactions",
// which is materially narrower even though it doesn't fully close it: the
// two rows are locked item-then-session here (matching
// item/[id]/complete/route.js), so a genuine concurrent write race against
// THAT route's own item-then-session locking cannot deadlock, but a
// genuine concurrent write race against slot/[name]/route.js's
// session-then-item locking still theoretically could. Fully eliminating
// that would mean unifying lock order across those two existing routes
// too - a larger, separate change; Postgres's deadlock detector aborts one
// side cleanly (an error the caller's transaction handling already
// surfaces) rather than corrupting data, so this residual risk is a rare
// availability hiccup, not a correctness one.

function needsReconciliation({ premiseActive, sourceValue, currentPickupFacility }) {
  if (!premiseActive || !hasMeaningfulValue(sourceValue)) return "reopen";
  if (currentPickupFacility !== sourceValue) return "resync";
  return null;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * @param {object} params
 * @param {import("pg").PoolClient} params.client - live client, mid-transaction with the caller's own write
 * @param {string} params.sessionId
 * @returns {Promise<{ updates: Array<{item_id: string, slot_name: string, status: string, extracted_value: unknown, cleared_reason: string}>, slotsFilled: Record<string, unknown> }>}
 */
export async function reconcileDerivedSlots({ client, sessionId }) {
  const updates = [];

  // Plain (non-locking) read - just decides WHETHER anything needs to
  // change. status = 'completed' is filtered here, not in the loop below,
  // so an already-skipped/pending row is never even a candidate.
  const { rows: [session] } = await client.query(
    `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1`,
    [sessionId]
  );
  const slotsFilled = session?.slots_filled && typeof session.slots_filled === "object" ? session.slots_filled : {};

  const { rows: derivedRows } = await client.query(
    `SELECT ist.item_id, i.slot_name, ist.derived_from_slot
       FROM aa_workflow_item_status ist
       JOIN aa_workflow_items i ON i.id = ist.item_id
      WHERE ist.session_id = $1 AND ist.derived_from_slot IS NOT NULL AND ist.status = 'completed'`,
    [sessionId]
  );

  for (const row of derivedRows) {
    // Only relationship currently wired up. Written as an explicit check
    // (not assumed) so an unrelated future derived_from_slot use can't be
    // silently mishandled by this pickup_facility-specific logic.
    if (row.slot_name !== "pickup_facility" || row.derived_from_slot !== "caller_facility") continue;

    const requesterSameValue = slotsFilled.pickup_same_as_requesting_facility;
    const premiseActive = requesterSameValue === true || /^(true|yes)$/i.test(String(requesterSameValue ?? ""));
    const sourceValue = slotsFilled.caller_facility;

    const action = needsReconciliation({ premiseActive, sourceValue, currentPickupFacility: slotsFilled.pickup_facility });
    if (!action) continue; // already consistent - never locked at all

    // Only NOW, immediately before an actual write, lock BOTH rows this
    // write touches - both scope and duration are as small as they can be.
    // Re-verify against the locked (now-authoritative) state: the plain
    // read above could be stale by the time these locks are acquired (a
    // concurrent skip, correction, or another reconciliation pass may have
    // already handled this row), so re-check rather than trust the earlier
    // snapshot for the write itself.
    const { rows: [lockedItem] } = await client.query(
      `SELECT status, derived_from_slot FROM aa_workflow_item_status
        WHERE session_id = $1 AND item_id = $2 FOR UPDATE`,
      [sessionId, row.item_id]
    );
    if (!lockedItem || lockedItem.status !== "completed" || lockedItem.derived_from_slot !== "caller_facility") continue;
    const { rows: [lockedSession] } = await client.query(
      `SELECT slots_filled FROM aa_workflow_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    const freshSlotsFilled = lockedSession?.slots_filled && typeof lockedSession.slots_filled === "object" ? lockedSession.slots_filled : {};
    const freshRequesterSameValue = freshSlotsFilled.pickup_same_as_requesting_facility;
    const freshPremiseActive = freshRequesterSameValue === true || /^(true|yes)$/i.test(String(freshRequesterSameValue ?? ""));
    const freshSourceValue = freshSlotsFilled.caller_facility;
    const freshAction = needsReconciliation({
      premiseActive: freshPremiseActive,
      sourceValue: freshSourceValue,
      currentPickupFacility: freshSlotsFilled.pickup_facility,
    });
    if (!freshAction) continue; // resolved by someone else while we waited for the locks

    if (freshAction === "reopen") {
      // Premise broke (boolean corrected to false, or caller_facility
      // itself got cleared) — reopen rather than carry a stale facility
      // name into read-back/dispatch.
      await client.query(
        `UPDATE aa_workflow_item_status
           SET status = 'pending', extracted_value = NULL, completed_at = NULL,
               confidence_score = NULL, source_transcript = NULL, alternatives = NULL,
               completed_by = NULL, is_manual_edit = FALSE, derived_from_slot = NULL,
               updated_at = NOW()
         WHERE session_id = $1 AND item_id = $2`,
        [sessionId, row.item_id]
      );
      await client.query(
        `UPDATE aa_workflow_sessions
           SET slots_filled = slots_filled - 'pickup_facility',
               slots_version = COALESCE(slots_version, 0) + 1, updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      delete slotsFilled.pickup_facility;
      updates.push({
        item_id: row.item_id,
        slot_name: "pickup_facility",
        status: "pending",
        extracted_value: null,
        cleared_reason: "pickup_facility_copy_premise_changed",
      });
    } else {
      // Premise still holds but the source drifted (caller_facility was
      // corrected to a different value) — resync rather than leave the old
      // name in place. Relies on the existing MCP-binding fingerprint
      // mechanism to notice pickup_facility changed and re-run
      // lookup_addresses on its own; nothing the reference workflow-workflow-specific is
      // hardcoded here.
      await client.query(
        `UPDATE aa_workflow_item_status
           SET extracted_value = $1, updated_at = NOW()
         WHERE session_id = $2 AND item_id = $3`,
        [freshSourceValue, sessionId, row.item_id]
      );
      await client.query(
        `UPDATE aa_workflow_sessions
           SET slots_filled = slots_filled || jsonb_build_object('pickup_facility', $1::text),
               slots_version = COALESCE(slots_version, 0) + 1, updated_at = NOW()
         WHERE id = $2`,
        [freshSourceValue, sessionId]
      );
      slotsFilled.pickup_facility = freshSourceValue;
      updates.push({
        item_id: row.item_id,
        slot_name: "pickup_facility",
        status: "completed",
        extracted_value: freshSourceValue,
        cleared_reason: "pickup_facility_copy_resynced",
      });
    }
  }

  return { updates, slotsFilled };
}
