/**
 * Concurrent concept-group batching (experimental).
 *
 * When a debounce batch contains multiple utterances, they're normally
 * processed strictly sequentially, because a later utterance's
 * disambiguation can depend on seeing an earlier one's just-written slot
 * value. In practice, most of that risk is concentrated in ONE specific
 * pattern: paired slots that share a base concept across stages
 * (pickup_room / destination_room, etc.) — exactly what the cross-stage
 * bleed guards in analyze/route.js exist to protect. Utterances touching
 * UNRELATED concept groups (e.g. caller identity vs. patient details) carry
 * much lower cross-talk risk, since their slot types don't structurally
 * resemble each other.
 *
 * computeConceptGroups partitions the workflow's stages into groups, merging
 * any stages that share a paired baseSlotKey into one group (so pickup +
 * destination are ALWAYS the same group, never split), leaving everything
 * else grouped by its own stage. classifyUtteranceGroup then cheaply (no LLM
 * call) guesses which group a given utterance's own text is about, so the
 * analyze route can run different-group utterances in concurrent DB
 * transactions while keeping same-group utterances sequential.
 */

export const baseSlotKey = (slotName) =>
  String(slotName || "").replace(/^(pickup|destination|sending|receiving)_/, "");

export function computeConceptGroups(allWorkflowItemRows) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const row of allWorkflowItemRows) {
    if (!parent.has(row.stage_name)) parent.set(row.stage_name, row.stage_name);
  }
  const stagesByBase = new Map();
  for (const row of allWorkflowItemRows) {
    if (!row.slot_name) continue;
    const base = baseSlotKey(row.slot_name);
    if (base === row.slot_name) continue; // not a paired slot
    if (!stagesByBase.has(base)) stagesByBase.set(base, new Set());
    stagesByBase.get(base).add(row.stage_name);
  }
  for (const stageNames of stagesByBase.values()) {
    const [first, ...rest] = [...stageNames];
    for (const s of rest) union(first, s);
  }

  const itemGroup = new Map(); // item_id -> groupKey
  const groupItemIds = new Map(); // groupKey -> Set(item_id)
  const groupHintTokens = new Map(); // groupKey -> Set(token)
  for (const row of allWorkflowItemRows) {
    const groupKey = find(row.stage_name);
    itemGroup.set(row.item_id, groupKey);
    if (!groupItemIds.has(groupKey)) groupItemIds.set(groupKey, new Set());
    groupItemIds.get(groupKey).add(row.item_id);
    const text = [row.label, row.prompt_hint, row.slot_name, ...(Array.isArray(row.hints) ? row.hints : [])]
      .filter(Boolean)
      .join(" ");
    if (!groupHintTokens.has(groupKey)) groupHintTokens.set(groupKey, new Set());
    for (const token of tokenizeForGrouping(text)) groupHintTokens.get(groupKey).add(token);
  }
  return { itemGroup, groupItemIds, groupHintTokens };
}

const GROUPING_STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "from", "have", "has",
  "can", "could", "would", "should", "what", "when", "where", "how", "why", "who",
]);

export function tokenizeForGrouping(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !GROUPING_STOP_WORDS.has(t));
}

/**
 * Cheap (no LLM call), best-effort guess at which concept group an utterance
 * is about, purely from lexical overlap with each group's own item labels/
 * hints. Returns null when the utterance carries no clear signal (e.g. a
 * bare "412" or "yes") — callers should treat null as "inherit the
 * PRECEDING utterance's group", since a bare fragment is exactly the case
 * that most needs to stay sequential relative to whatever was just discussed.
 */
export function classifyUtteranceGroup(transcript, groupHintTokens) {
  const tokens = tokenizeForGrouping(transcript);
  if (tokens.length === 0) return null;
  let bestGroup = null;
  let bestScore = 0;
  for (const [groupKey, hintTokens] of groupHintTokens) {
    let score = 0;
    for (const t of tokens) if (hintTokens.has(t)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestGroup = groupKey;
    }
  }
  return bestScore > 0 ? bestGroup : null;
}
