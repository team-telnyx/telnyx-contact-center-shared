/**
 * an earlier fix: infer "no bed" when no room number is provided.
 *
 * A scene pickup or a residence has no room, and therefore no bed. Before this,
 * a room resolved as "N/A" still left the bed slot open, so the suggested-
 * response panel went on to ask "and what's the bed number?" for a location
 * that has neither. The caller then had to answer a question that could not
 * have an answer, and the stage could not complete.
 *
 * A bed is paired to its room by slot name — `pickup_bed` -> `pickup_room`,
 * `destination_bed` -> `destination_room` — so the rule follows the workflow
 * definition rather than positional guessing, and holds for the air ambulance
 * workflow first and ground second (an earlier fix) without either naming a pair
 * explicitly.
 *
 * The inference only ever RESOLVES a bed the caller was never going to answer.
 * It never overwrites a bed that already has a value, and the agent can still
 * edit the resolved bed by hand afterwards.
 */

/** The sentinel the analyzer prompt already uses for "asked, no value exists". */
export const NO_BED_VALUE = "N/A";

/**
 * `completed_by` marker for an inferred resolution. Deliberately not "ai" (no
 * model produced it) and not "agent" (nobody clicked anything) so the desktop
 * can label it honestly and the agent knows why the bed says N/A.
 */
export const INFERRED_BY = "inferred";

/** Values that mean "there is no room here", not "the room is <number>". */
const NONE_TOKENS = new Set([
  "n/a", "na", "n.a.", "n/a.", "-", "--", "—",
  "none", "no", "nil", "null", "nothing",
  "unknown", "unk", "not applicable", "notapplicable",
  "tbd", "to be determined", "not assigned", "unassigned",
  "not available", "no value", "not provided", "no room", "no bed",
]);

/** "no room", "without a room", "not in a room". */
const NO_ROOM_PHRASE = /\b(?:no|without(?:\s+an?)?|not\s+(?:in\s+)?an?)\s+room\b/;

/** "room number is n/a", "room not assigned", "room: unknown". */
const ROOM_RESOLVED_NONE =
  /\broom\b(?:\s*number)?[^a-z0-9]{0,4}(?:is\s+)?(?:n\/?a|none|unknown|tbd|not\s+(?:assigned|applicable|available))\b/;

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Present and non-empty. Mirrors the presence checks used across agent-assist. */
function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/** Item id, whether the row came from an aliased join (`item_id`) or a plain select (`id`). */
function itemIdOf(item) {
  return item?.item_id ?? item?.id;
}

/**
 * Does this captured room value mean "there is no room"?
 *
 * Deliberately conservative: a room slot that is simply UNFILLED is not a no-
 * room answer (the caller hasn't been asked yet), and any value that reads like
 * a real room — "302", "4 North", "ER bay 2" — is left alone. Only an explicit
 * not-applicable answer counts.
 */
export function isNoRoomValue(value) {
  if (typeof value === "boolean") return false;
  const v = normalize(value);
  if (!v) return false;
  if (NONE_TOKENS.has(v)) return true;
  // "N.A." / "n / a" collapse onto the same token.
  if (NONE_TOKENS.has(v.replace(/[.\s]/g, ""))) return true;
  return NO_ROOM_PHRASE.test(v) || ROOM_RESOLVED_NONE.test(v);
}

/** Is this slot name a bed slot? Matches `bed`, `pickup_bed`, `bed_number`. */
export function isBedSlotName(slotName) {
  return /(^|_)bed(_|$)/.test(normalize(slotName).replace(/\s+/g, "_"));
}

/** Is this slot name a room slot? The counterpart of isBedSlotName. */
export function isRoomSlotName(slotName) {
  return /(^|_)room(_|$)/.test(normalize(slotName).replace(/\s+/g, "_"));
}

/**
 * The room slot that pairs with a bed slot, by name substitution:
 * `pickup_bed` -> `pickup_room`, `bed_number` -> `room_number`. Returns null
 * when the slot isn't a bed slot at all.
 */
export function roomSlotNameForBed(bedSlotName) {
  const name = normalize(bedSlotName).replace(/\s+/g, "_");
  if (!isBedSlotName(name)) return null;
  return name.replace(/(^|_)bed(_|$)/, (_match, pre, post) => `${pre}room${post}`);
}

/**
 * Which bed slots should now resolve to "no bed"?
 *
 * @param items         Workflow items still open (needs `type`, `slot_name`).
 * @param slotsFilled   Current captured values, keyed by slot name.
 * @param noRoomSlotNames  Room slots known to be resolved as not-applicable by
 *                         something other than their value — e.g. the agent
 *                         skipped the room item, which writes no slot value.
 * @returns [{ item, roomSlotName, roomValue }] — empty when nothing applies.
 */
export function bedSlotsToResolve({ items = [], slotsFilled = {}, noRoomSlotNames = [] } = {}) {
  const skippedRooms = new Set((noRoomSlotNames || []).filter(Boolean).map((n) => normalize(n)));
  const resolved = [];

  for (const item of items || []) {
    if (item?.type !== "slot" || !item.slot_name) continue;

    const roomSlotName = roomSlotNameForBed(item.slot_name);
    if (!roomSlotName) continue;

    // Never overwrite a bed the caller actually gave, or one already resolved.
    if (hasValue(slotsFilled[item.slot_name])) continue;

    const roomValue = slotsFilled[roomSlotName];
    const roomIsNone =
      skippedRooms.has(roomSlotName) || (hasValue(roomValue) && isNoRoomValue(roomValue));
    if (!roomIsNone) continue;

    resolved.push({
      item,
      itemId: itemIdOf(item),
      roomSlotName,
      roomValue: hasValue(roomValue) ? roomValue : null,
    });
  }

  return resolved;
}

/**
 * Resolve every inferable bed slot against the database: marks each item
 * completed and mutates `slotsFilled` in place. Returns the resolved entries so
 * the caller can build its own response delta and logging — this deliberately
 * does NOT write `aa_workflow_sessions.slots_filled`, because each caller
 * commits that differently (the analyzer batches a jsonb merge, the manual
 * routes write the whole object).
 *
 * Idempotent: a bed that already holds a value is filtered out by
 * bedSlotsToResolve, so re-running over the same session is a no-op.
 *
 * The write itself is guarded, not just the in-memory check. `items` and
 * `slotsFilled` are a snapshot, and the analyzer deliberately runs concept
 * groups concurrently on separate connections — so a bed can be answered for
 * real between the read and this statement. The UPDATE therefore refuses any
 * row that is no longer open or has since acquired a value, and only the rows
 * it actually claimed are reported back and written into slotsFilled. Losing
 * the race means the caller's real bed number stands, which is the safe
 * outcome.
 */
export async function resolveInferredBeds({
  client,
  sessionId,
  items = [],
  slotsFilled = {},
  noRoomSlotNames = [],
}) {
  const candidates = bedSlotsToResolve({ items, slotsFilled, noRoomSlotNames });
  const resolved = [];

  for (const entry of candidates) {
    // clock_timestamp() not NOW(): NOW() is frozen at the start of a batch
    // transaction, and the analyzer's bleed guard compares against real
    // completion times.
    const { rows } = await client.query(
      `UPDATE aa_workflow_item_status
          SET status = 'completed',
              completed_at = clock_timestamp(),
              completed_by = $1,
              extracted_value = $2,
              confidence_score = 1,
              alternatives = NULL,
              updated_at = NOW()
        WHERE session_id = $3
          AND item_id = $4
          AND status IN ('pending', 'suggested')
          AND (extracted_value IS NULL OR extracted_value = '')
        RETURNING item_id`,
      [INFERRED_BY, NO_BED_VALUE, sessionId, entry.itemId]
    );

    // No row claimed: something else answered this bed first. Leave it alone.
    if (!rows || rows.length === 0) continue;

    slotsFilled[entry.item.slot_name] = NO_BED_VALUE;
    resolved.push(entry);
  }

  return resolved;
}
