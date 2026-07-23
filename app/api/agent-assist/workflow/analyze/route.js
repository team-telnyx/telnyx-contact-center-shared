/**
 * Agent Assist Workflow - Analyze API
 * POST - Analyze transcript for workflow item completion and slot extraction
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { analyzeWorkflowTranscript } from "@/lib/agent-assist/workflow-analyzer";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { isReadBackItem, mentionsCorrectionTrigger, matchesReadBackAffirmativeHints } from "@/lib/agent-assist/readback.mjs";
import { isAccumulatingSlot, accumulateSlotValue } from "@/lib/agent-assist/slot-accumulate.mjs";

// How many pending items to send the analyzer per utterance. The old cap of 12
// starved larger intakes: on a 24+ slot workflow the first 12 pending items only
// reach the Destination stage, so Patient / Clinical / Trip-notes / Air-safety
// slots were NEVER analyzed and could not capture. Widened to cover realistic
// workflows — the output stays small (only matched items are returned) and the
// analyzer's max_tokens already scales with item count.
const MAX_ANALYZER_PENDING_ITEMS = 40;

// No-information sentinels the analyzer may legitimately store in BOTH a first-
// and last-name slot when the caller doesn't know a name ("N/A", "unknown", ...).
// The duplicate-name reconciliation must NOT treat these shared sentinels as a
// mis-captured surname, or it would clear + re-ask the first name forever.
const NAME_DUP_SENTINELS = new Set([
  "n/a", "na", "n a", "unknown", "unk", "none", "not known", "not available",
  "not provided", "no name",
]);

function normalizeConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1) {
    return 0.95;
  }
  return Math.round(numericValue * 100) / 100;
}

function normalizeSpeakerType(speaker) {
  if (speaker === "inbound" || speaker === "customer") return "customer";
  if (speaker === "outbound" || speaker === "agent") return "agent";
  return null;
}

function hasMeaningfulExtractedValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// POST /api/agent-assist/workflow/analyze - Analyze transcript
export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { sessionId, interactionId, transcript, speaker, recentContext } = body;

    if (!transcript?.trim()) {
      return NextResponse.json(
        { error: "transcript is required" },
        { status: 400 }
      );
    }

    // Find session
    let workflowSession;
    if (sessionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE id = $1 AND status = 'in_progress'`,
        [sessionId]
      );
      workflowSession = s;
    } else if (interactionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1 AND status = 'in_progress'`,
        [interactionId]
      );
      workflowSession = s;
    }

    if (!workflowSession) {
      workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
        sessionId,
        interactionId,
        reason: "no_active_workflow_session",
      }));
      return NextResponse.json({
        ok: true,
        message: "No active workflow session found",
        updates: [],
      });
    }

    let assistConfig = {};
    if (workflowSession.interaction_id) {
      const { rows: [interaction] } = await pool.query(
        `SELECT metadata FROM cc_interactions WHERE id = $1`,
        [workflowSession.interaction_id]
      );
      assistConfig = interaction?.metadata?.agent_assist_config || {};
    }

    if (assistConfig.auto_detect_completion === false) {
      workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.interaction_id,
        workflowId: workflowSession.workflow_id,
        reason: "auto_detect_completion_disabled",
      }));
      return NextResponse.json({
        ok: true,
        message: "Auto-detect completion is disabled",
        updates: [],
      });
    }

    // Get unfinished items for current and upcoming stages.
    // Include suggested rows so a later, clearer utterance can replace a low-confidence
    // suggestion instead of freezing the slot until the agent edits it manually.
    const { rows: pendingItems } = await pool.query(
      `SELECT 
        i.id as item_id,
        i.type,
        i.label,
        i.prompt_hint,
        i.slot_name,
        i.slot_type,
        i.slot_options,
        i.slot_validation,
        i.completion_trigger,
        i.hints,
        s.name as stage_name,
        s.order_index as stage_order,
        ist.status as current_status
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
       WHERE s.workflow_id = $2 
         AND ist.status IN ('pending', 'suggested')
       ORDER BY s.order_index, i.order_index`,
      [workflowSession.id, workflowSession.workflow_id]
    );

    const speakerType = normalizeSpeakerType(speaker);
    const relevantPendingItems = pendingItems
      .filter((item) => {
        const completionTrigger = item.completion_trigger || "agent";
        return (
          Boolean(speakerType) &&
          (completionTrigger === "either" || completionTrigger === speakerType)
        );
      })
      .slice(0, MAX_ANALYZER_PENDING_ITEMS);

    // Needed by isReadBackStage below (moved up from its previous spot further
    // down this function — see the comment there for why).
    const slotsFilled = workflowSession.slots_filled || {};

    // Are we at the final read-back/confirmation step? A read-back-matching
    // item (e.g. "Confirm all information is correct") stays pending for the
    // ENTIRE call until the very end, so checking pendingItems alone (as an
    // earlier version of this code did) makes isReadBackStage true from the
    // FIRST utterance onward — re-including every already-completed slot as a
    // "correction candidate" (see below) and adding the correction prompt
    // section for the whole call, not just read-back. That widened window is
    // exactly what let a pickup-stage address utterance get misattributed to
    // destination_facility: destination_facility was ALSO sitting in view as
    // a correction candidate, adding noise right when the model should be
    // tightly focused on pickup vs. destination. Require BOTH: a read-back
    // item is pending, AND every slot-type item is already collected — read-
    // back is only reached once there is nothing left to collect.
    //
    // A slot-type item with status "pending"/"suggested" does NOT count as
    // "still needs collecting" when slots_filled already has a value for
    // it — that's a correction candidate whose confirmation is still pending
    // (see the always-suggested correction branch below), not a genuine gap.
    // Without this exception, confirming ONE correction (e.g. date of birth)
    // would make that slot itself "pending" again, which would flip
    // isReadBackStage back to false and hide every OTHER slot from being
    // corrected until that one confirmation was resolved — i.e. only one
    // correction could ever be in flight at a time.
    const isReadBackStage =
      !pendingItems.some(
        (item) => item.type === "slot" && !hasMeaningfulExtractedValue(slotsFilled[item.slot_name])
      ) &&
      pendingItems.some((item) =>
        isReadBackItem({
          itemType: item.type,
          itemLabel: item.label,
          itemPromptHint: item.prompt_hint,
          itemHints: item.hints,
        })
      );

    // Was a correction just flagged, in this utterance or a recent one? STT
    // often mangles a corrected value differently on each retry (e.g. "Twin
    // Hill" / "Stonemere" / "John Miller" for "John Muir Hospital"), and the
    // caller then just repeats a plain name instead of re-explaining "that's
    // still wrong" every single time. When true, the correction prompt (below)
    // is told it can accept a bare restated value as continuing that same
    // correction instead of requiring the explicit trigger phrase again.
    const correctionInProgress =
      isReadBackStage &&
      (mentionsCorrectionTrigger(transcript) ||
        (Array.isArray(recentContext) ? recentContext.some((c) => mentionsCorrectionTrigger(c?.text)) : false));

    // Free-text notes slots keep accumulating AFTER they complete: a completed
    // item drops out of the pending set, so later STT fragments of a multi-
    // sentence note would be lost. Re-include completed accumulating (notes)
    // slots in the analyzer INPUT only — not in pendingItems — so subsequent
    // fragments accumulate without affecting the read-back guard or the current
    // target. Fetched BEFORE the empty-pending check so a note still accumulates
    // when it is the only thing the customer is still adding to.
    const { rows: completedSlotRows } = await pool.query(
      `SELECT i.id as item_id, i.type, i.label, i.prompt_hint, i.slot_name,
              i.slot_type, i.slot_options, i.slot_validation, i.completion_trigger,
              i.hints, s.name as stage_name, s.order_index as stage_order,
              ist.status as current_status,
              ist.completed_at, ist.extracted_value as completed_value
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
        WHERE s.workflow_id = $2 AND ist.status = 'completed' AND i.type = 'slot'
        ORDER BY s.order_index, i.order_index`,
      [workflowSession.id, workflowSession.workflow_id]
    );
    const completedNotesItems = completedSlotRows.filter((it) => {
      if (!isAccumulatingSlot(it)) return false;
      const trigger = it.completion_trigger || "agent";
      return Boolean(speakerType) && (trigger === "either" || trigger === speakerType);
    });

    // At the read-back step only, re-include every OTHER already-completed slot
    // too — as correction candidates, not for re-collection. Outside this
    // stage, a completed slot stays fully out of the analyzer's view (see
    // "pending items" query above), so an offhand later mention of a value
    // can't accidentally overwrite it. Scoped to read-back because that's the
    // one moment a caller is expected to review and correct prior answers;
    // the prompt (buildWorkflowAnalysisSystemPrompt) is the actual gate that
    // requires an EXPLICIT correction statement before returning one of these.
    const correctionCandidateItems = isReadBackStage
      ? completedSlotRows.filter((it) => !isAccumulatingSlot(it))
      : [];
    const analyzerItems = [...relevantPendingItems, ...completedNotesItems, ...correctionCandidateItems];

    if (analyzerItems.length === 0) {
      workflowLogger.info("workflow_analysis_skipped", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.interaction_id,
        workflowId: workflowSession.workflow_id,
        reason: "no_relevant_pending_items",
        pendingItems: pendingItems.length,
        speaker: speaker || null,
      }));
      return NextResponse.json({
        ok: true,
        message: "No pending items to analyze",
        updates: [],
      });
    }

    // NOTE: the safe half of a "skip agent questions" optimization already lives
    // in the empty-analyzerItems early-return above — for an agent utterance,
    // relevantPendingItems is filtered to only `either`/`agent`-triggered items,
    // so when the only open items are customer-only slots the LLM is already
    // skipped. We do NOT additionally skip agent utterances while `either` slots
    // are open: this workflow lets the agent state values for either-triggered
    // slots ("Can I get Mercy for the pickup facility?"), so any text heuristic
    // to guess "asking vs stating" would drop real captures.

    // slotsFilled (the snapshot read at request start) was moved up above,
    // next to isReadBackStage which needs it. `slotsDelta` accumulates ONLY
    // the slots this request changes, so the persist can jsonb-merge the
    // delta instead of overwriting the whole object. Overwriting is a
    // lost-update race: when analyze is slow, two requests overlap, each
    // reads this snapshot, and the later write wipes the earlier one's slots
    // (e.g. a freshly captured `other_aircraft_responding: false` vanishes, so
    // the suggested response re-targets an already-filled slot).
    const slotsDelta = {};

    // Get workflow's LLM model and confidence threshold
    const { rows: [workflow] } = await pool.query(
      `SELECT llm_model, llm_confidence_threshold FROM aa_workflows WHERE id = $1`,
      [workflowSession.workflow_id]
    );
    const llmModel = workflow?.llm_model || "openai/gpt-4o";
    const confidenceThreshold = normalizeConfidenceThreshold(workflow?.llm_confidence_threshold);

    // Bleed guard: find the most recently completed slot (within a short window).
    // A stray numeric tail of a just-answered slot (e.g. "eight" from "nineteen
    // sixty-eight" arriving after DOB was captured as "1960-03-12") must not
    // bleed into the next pending slot (e.g. weight). Only activate when the
    // transcript itself looks like a numeric/ordinal fragment — clear boolean
    // answers ("No", "Yes") must NEVER be caught by this guard.
    const BLEED_WINDOW_MS = 8000;
    const NUMERIC_FRAGMENT_RE = /^(?:\d+(?:st|nd|rd|th)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)(?:[\s-]+(?:\d+(?:st|nd|rd|th)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth))*$/i;
    const transcriptWords = transcript.trim().split(/\s+/);
    const isNumericFragment = transcriptWords.length <= 3 && NUMERIC_FRAGMENT_RE.test(transcript.trim());
    const recentlyCompletedSlot = isNumericFragment
      ? (completedSlotRows
          .filter((r) => r.completed_at && r.completed_value != null)
          .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
          .find((r) => Date.now() - new Date(r.completed_at).getTime() < BLEED_WINDOW_MS)
          ?? null)
      : null;
    const bleedGuardSlot = recentlyCompletedSlot
      ? { slotName: recentlyCompletedSlot.slot_name, slotType: recentlyCompletedSlot.slot_type, value: recentlyCompletedSlot.completed_value }
      : null;

    // The slot the agent is currently collecting = the earliest still-open OR
    // still-unconfirmed slot (pendingItems are ordered by stage, then item).
    // Passed to the analyzer so an ambiguous answer is assigned to the slot
    // actually being asked, instead of a same-looking slot elsewhere (e.g. a
    // mis-heard destination facility going into a patient-name slot).
    //
    // Includes "suggested" (not just "pending"): a low-confidence capture
    // isn't confirmed yet, and the caller often repeats/clarifies it on the
    // very next turn. If that turn were treated as "moved on", current focus
    // would already be pointing at whatever's next (e.g. sending_physician
    // suggested at low confidence -> focus jumps to receiving_physician), so
    // an unrelated bare repeat of the SAME name gets misattributed to the
    // NEXT slot instead of confirming/refining the one actually still in
    // question. Reported live: "I was talking only sending physician name but
    // it fills up to both sending physician and receiving physician."
    const currentTargetItem = pendingItems.find(
      (i) => i.type === "slot" && (i.current_status === "pending" || i.current_status === "suggested")
    );
    const currentTarget = currentTargetItem
      ? { label: currentTargetItem.label, slotName: currentTargetItem.slot_name }
      : null;
    // Stage name of the currently active stage, used by the LLM stage-boundary
    // rule to prevent cross-stage slot bleed (e.g. pickup dept bleeding into
    // destination dept).
    const currentStageName = currentTargetItem?.stage_name
      ?? pendingItems.find(i => i.current_status === "pending")?.stage_name
      ?? null;

    // Narrow the analyzer's input to the current stage (+ a small look-ahead
    // buffer) instead of every open item across the whole remaining workflow.
    // Smaller prompt -> faster inference, and fewer structurally-similar
    // future-stage slots in view to accidentally bleed into (the hard
    // backstop below still applies as defense-in-depth regardless). Still-open
    // items from EARLIER stages stay visible — the agent may circle back to a
    // skipped question — only far-future stages are trimmed.
    //
    // completedNotesItems are deliberately EXEMPT from narrowing: they're
    // already-completed, still-accumulating notes slots (see comment above
    // completedSlotRows) that must stay analyzable regardless of which stage
    // they belong to, or a later fragment of that note would stop accumulating.
    //
    // "suggested" items (a slot already captured at low confidence, awaiting
    // an explicit confirmation utterance) are ALSO exempt, for the same
    // reason: currentTargetItem anchors on the EARLIEST still-open slot, which
    // can regress back to an early stage once every later-stage slot is
    // either completed or merely "suggested" (e.g. one slot in "Intent
    // Identification" never got filled, so once every later stage's slots
    // are captured, that one early slot becomes the only remaining
    // type=slot/status=pending row and currentStageOrder snaps back to it).
    // Without this exemption, that regression narrows the analyzer's view
    // down to the early stage and permanently hides a later "suggested" slot
    // from ever being re-analyzed — so its confirmation utterance ("two IV
    // drips is correct") is never seen, the slot never flips to "completed",
    // and the low-confidence-confirmation fallback keeps re-prompting for it
    // near the end of the call even though the agent already confirmed it.
    // The read-back/"confirm all information" item is ALSO exempt, for the
    // same regression: it's a non-slot PENDING item (not "suggested"), so the
    // exemption above doesn't cover it. It sits in the final stage, so any
    // regression at all pushes it out of the narrowed window — permanently
    // hiding it from the analyzer even while the customer is actively giving
    // the read-back affirmative ("yes, all information is correct"), leaving
    // the read-back stuck open with no way to ever complete it.
    const NARROW_STAGE_LOOKAHEAD = 1;
    const currentStageOrder = currentTargetItem?.stage_order
      ?? pendingItems.find(i => i.current_status === "pending")?.stage_order
      ?? null;
    const narrowedRelevantPendingItems = currentStageOrder == null
      ? relevantPendingItems
      : relevantPendingItems.filter((item) =>
          item.current_status === "suggested" ||
          (item.stage_order ?? 0) <= currentStageOrder + NARROW_STAGE_LOOKAHEAD ||
          isReadBackItem({
            itemType: item.type,
            itemLabel: item.label,
            itemPromptHint: item.prompt_hint,
            itemHints: item.hints,
          })
        );
    // correctionCandidateItems are exempt from narrowing for the same reason as
    // completedNotesItems: they're already-completed slots from potentially
    // any earlier stage, re-included ONLY so an explicit correction at the
    // read-back step can be captured — narrowing by stage distance would
    // defeat that (a correction to an early-stage slot must stay visible even
    // though currentStageOrder now sits at the final Confirmation stage).
    const narrowedAnalyzerItems = [...narrowedRelevantPendingItems, ...completedNotesItems, ...correctionCandidateItems];
    workflowLogger.debug("workflow_analyzer_items_narrowed", agentAssistRuntimePayload({
      sessionId: workflowSession.id,
      interactionId: workflowSession.interaction_id,
      currentStageName,
      currentStageOrder,
      isReadBackStage,
      correctionInProgress,
      correctionCandidates: correctionCandidateItems.length,
      beforeCount: analyzerItems.length,
      afterCount: narrowedAnalyzerItems.length,
    }));

    // Call LLM analyzer (using workflow's configured model)
    const analysisResult = await analyzeWorkflowTranscript({
      transcript,
      speaker: speaker || "unknown",
      pendingItems: narrowedAnalyzerItems,
      slotsFilled,
      model: llmModel,
      includeIntent: assistConfig.enable_intent_recognition === true,
      includeSentiment: assistConfig.enable_sentiment_analysis === true,
      confidenceThreshold,
      currentTarget,
      currentStageName,
      isReadBackStage,
      correctionInProgress,
      recentContext: Array.isArray(recentContext) ? recentContext.slice(-6) : [],
      bleedGuardSlot,
    });

    // Hard backstop for cross-stage slot bleed (e.g. pickup_department also
    // filling destination_department) that slips past the LLM's stage-boundary
    // prompt instruction. Prompt-only guidance is a strong nudge, not an
    // enforced rule — the model can still copy a value to a structurally
    // identical slot in a later stage within the SAME response. Detect that
    // exact pattern here: two items in this response share a base slot concept
    // (stripping a pickup_/destination_/sending_/receiving_ prefix) and an
    // identical extracted value — keep only the earlier-stage one.
    const baseSlotKey = (slotName) =>
      String(slotName || "").replace(/^(pickup|destination|sending|receiving)_/, "");
    const normalizeForBleedCheck = (value) => String(value ?? "").trim().toLowerCase();
    const bleedRejectedItemIds = new Set();
    {
      const itemById = new Map(analyzerItems.map((i) => [i.item_id, i]));
      const candidates = (analysisResult.completed_items || [])
        .map((completed) => {
          const item = itemById.get(completed.item_id);
          if (!item?.slot_name) return null;
          const base = baseSlotKey(item.slot_name);
          if (base === item.slot_name) return null; // no pickup_/destination_/etc. prefix — not a paired slot
          return {
            itemId: completed.item_id,
            base,
            stageOrder: item.stage_order,
            value: normalizeForBleedCheck(completed.extracted_value),
          };
        })
        .filter(Boolean);

      for (let a = 0; a < candidates.length; a++) {
        for (let b = a + 1; b < candidates.length; b++) {
          const x = candidates[a];
          const y = candidates[b];
          if (x.base !== y.base || !x.value || x.value !== y.value) continue;
          if (x.stageOrder === y.stageOrder) continue;
          const later = x.stageOrder > y.stageOrder ? x : y;
          bleedRejectedItemIds.add(later.itemId);
          workflowLogger.warn("workflow_stage_bleed_rejected", agentAssistRuntimePayload({
            sessionId: workflowSession.id,
            interactionId: workflowSession.interaction_id,
            rejectedItemId: later.itemId,
            baseSlotKey: x.base,
            value: x.value,
          }));
        }
      }
    }

    // Process completed items
    const updates = [];
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const completed of analysisResult.completed_items || []) {
        if (bleedRejectedItemIds.has(completed.item_id)) continue;
        // Get item details including completion_trigger (search the analyzer input,
        // which also carries completed notes slots still accumulating).
        const item = analyzerItems.find(p => p.item_id === completed.item_id);
        if (!item) continue;
        
        // Check if completion_trigger matches speaker
        const completionTrigger = item.completion_trigger || "agent";
        const shouldComplete =
          Boolean(speakerType) &&
          (completionTrigger === "either" ||
            (completionTrigger === "customer" && speakerType === "customer") ||
            (completionTrigger === "agent" && speakerType === "agent"));
        const hasExtractedSlotValue = item.type !== "slot" || hasMeaningfulExtractedValue(completed.extracted_value);

        // Ignore wrong-speaker detections and empty slot hits. This prevents an agent's
        // question or prompt hint from completing a customer-owned slot with a blank value.
        if (!shouldComplete || !hasExtractedSlotValue) {
          continue;
        }

        // Keep the final read-back / "confirm all information" item OPEN until every
        // slot has been collected AND confirmed. Otherwise a per-slot confirmation
        // exchange ("please confirm that's correct" / "that's correct") auto-completes
        // it and the agent never gets the full read-back. `pendingItems` still lists
        // any slot that is pending or an unconfirmed low-confidence suggestion.
        const hasUnconfirmedSlot = pendingItems.some((p) => p.type === "slot");
        if (
          item.type !== "slot" &&
          hasUnconfirmedSlot &&
          isReadBackItem({ itemType: item.type, itemLabel: item.label, itemPromptHint: item.prompt_hint, itemHints: item.hints })
        ) {
          continue;
        }

        // A notes slot that has ALREADY completed is re-analyzed so later
        // utterances of a multi-sentence note keep accumulating. Only append a
        // fragment that clears the confidence threshold — otherwise noisy/ambiguous
        // post-completion STT would be permanently glued onto the note. Dedup means
        // a repeated/echoed fragment is a no-op.
        if (item.current_status === "completed" && item.type === "slot" && isAccumulatingSlot(item)) {
          if (completed.confidence < confidenceThreshold) {
            continue;
          }
          const accumulated = accumulateSlotValue(slotsFilled[item.slot_name], completed.extracted_value);
          if (accumulated !== (slotsFilled[item.slot_name] ?? "")) {
            slotsFilled[item.slot_name] = accumulated;
            slotsDelta[item.slot_name] = accumulated;
            await client.query(
              `UPDATE aa_workflow_item_status
                 SET extracted_value = $1, source_transcript = $2, updated_at = NOW()
               WHERE session_id = $3 AND item_id = $4`,
              [accumulated, transcript, workflowSession.id, completed.item_id]
            );
            updates.push({
              item_id: completed.item_id,
              status: "completed",
              confidence: completed.confidence,
              extracted_value: accumulated,
              source_text: completed.source_text,
              alternatives: [],
            });
          }
          continue;
        }

        // A correction candidate (already-completed slot, re-included ONLY at
        // the read-back stage — see correctionCandidateItems) is ALWAYS
        // surfaced as "suggested" — pending agent confirmation — never
        // silently auto-completed and never silently dropped, regardless of
        // confidence. Confidence alone isn't a reliable signal for a
        // correction: STT can garble the corrected value into something that
        // still scores high confidence (e.g. "Stonemere" for "John Muir
        // Hospital" scored 0.92 and was auto-applied before this change,
        // landing on the wrong value with no visible flag that anything had
        // changed). Routing every correction through "suggested" reuses the
        // EXISTING low-confidence confirmation UI (chips / "please confirm")
        // instead of a silent overwrite, and — because a "suggested" slot is
        // NOT written to slots_filled until confirmed — the OLD value stays
        // authoritative for read-back until the agent explicitly confirms the
        // new one, so a bad guess can't silently become the record of truth.
        if (item.current_status === "completed") {
          if (!hasMeaningfulExtractedValue(completed.extracted_value)) continue;
          const correctionAlternatives =
            Array.isArray(completed.alternatives) && completed.alternatives.length > 0
              ? JSON.stringify(completed.alternatives)
              : null;
          await client.query(
            `UPDATE aa_workflow_item_status
               SET status = 'suggested',
                   completed_at = NULL,
                   completed_by = 'ai',
                   extracted_value = $1,
                   confidence_score = $2,
                   source_transcript = $3,
                   alternatives = $6::jsonb,
                   updated_at = NOW()
             WHERE session_id = $4 AND item_id = $5`,
            [
              completed.extracted_value,
              completed.confidence,
              transcript,
              workflowSession.id,
              completed.item_id,
              correctionAlternatives,
            ]
          );
          updates.push({
            item_id: completed.item_id,
            status: "suggested",
            confidence: completed.confidence,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
            alternatives: Array.isArray(completed.alternatives) ? completed.alternatives : [],
            completed_by: "ai",
            low_confidence: true,
            confidence_threshold: confidenceThreshold,
            is_correction: true,
          });
          continue;
        }

        // Only auto-complete if confidence is high enough; otherwise persist a suggestion.
        if (completed.confidence >= confidenceThreshold) {
          // Update item status
          await client.query(
            `UPDATE aa_workflow_item_status 
             SET status = 'completed',
                 completed_at = NOW(),
                 completed_by = $1,
                 extracted_value = $2,
                 confidence_score = $3,
                 source_transcript = $4,
                 alternatives = NULL,
                 updated_at = NOW()
             WHERE session_id = $5 AND item_id = $6`,
            [
              speakerType || "auto",
              completed.extracted_value ?? null,
              completed.confidence,
              transcript,
              workflowSession.id,
              completed.item_id,
            ]
          );

          // If this is a slot item with a value, update slots_filled. Use the
          // meaningful-value check (not truthiness) so boolean false / numeric 0
          // are kept — e.g. accompanying=false, iv_count=0. Free-text notes slots
          // accumulate across utterances instead of overwriting, so a multi-
          // sentence answer isn't reduced to its last fragment.
          if (item?.slot_name && hasMeaningfulExtractedValue(completed.extracted_value)) {
            slotsFilled[item.slot_name] = isAccumulatingSlot(item)
              ? accumulateSlotValue(slotsFilled[item.slot_name], completed.extracted_value)
              : completed.extracted_value;
            slotsDelta[item.slot_name] = slotsFilled[item.slot_name];
          }

          updates.push({
            item_id: completed.item_id,
            status: "completed",
            confidence: completed.confidence,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
            alternatives: [],
          });
        } else {
          // Persist as suggestion (don't auto-complete) so the agent can confirm or correct it.
          // Store the low-confidence alternatives so the agent desktop can render
          // confirmation chips (previously only the insights path produced these).
          const suggestedAlternatives =
            Array.isArray(completed.alternatives) && completed.alternatives.length > 0
              ? JSON.stringify(completed.alternatives)
              : null;
          await client.query(
            `UPDATE aa_workflow_item_status
             SET status = $1::varchar,
                 completed_at = NULL,
                 completed_by = 'ai',
                 extracted_value = $2,
                 confidence_score = $3,
                 source_transcript = $4,
                 alternatives = $7::jsonb,
                 updated_at = NOW()
             WHERE session_id = $5 AND item_id = $6`,
            [
              'suggested',
              completed.extracted_value ?? null,
              completed.confidence,
              transcript,
              workflowSession.id,
              completed.item_id,
              suggestedAlternatives,
            ]
          );

          updates.push({
            item_id: completed.item_id,
            status: "suggested",
            confidence: completed.confidence,
            extracted_value: completed.extracted_value,
            source_text: completed.source_text,
            alternatives: Array.isArray(completed.alternatives) ? completed.alternatives : [],
            completed_by: "ai",
            low_confidence: completed.confidence < confidenceThreshold,
            confidence_threshold: confidenceThreshold,
            completion_trigger_pending: !shouldComplete,
          });
        }
      }

      // Deterministic backstop: the read-back "confirm all information is
      // correct"-style item is a single, extremely high-value completion that
      // the LLM has repeatedly missed in live testing despite an unambiguous
      // customer affirmative. If the model didn't already flag it above, check
      // the raw transcript directly against the item's own hints and complete
      // it deterministically when customer-spoken at the read-back stage.
      // pendingItems only lists items still pending/suggested, so this
      // naturally no-ops once the item is already completed.
      if (isReadBackStage && speakerType === "customer") {
        const readBackConfirmItem = pendingItems.find(
          (item) =>
            item.completion_trigger === "customer" &&
            isReadBackItem({
              itemType: item.type,
              itemLabel: item.label,
              itemPromptHint: item.prompt_hint,
              itemHints: item.hints,
            })
        );
        const alreadyHandledThisTurn =
          readBackConfirmItem && updates.some((u) => u.item_id === readBackConfirmItem.item_id);
        if (
          readBackConfirmItem &&
          !alreadyHandledThisTurn &&
          matchesReadBackAffirmativeHints(transcript, readBackConfirmItem)
        ) {
          await client.query(
            `UPDATE aa_workflow_item_status
               SET status = 'completed', completed_at = NOW(), completed_by = $1,
                   extracted_value = $2, confidence_score = 1, source_transcript = $3,
                   alternatives = NULL, updated_at = NOW()
             WHERE session_id = $4 AND item_id = $5`,
            [speakerType, true, transcript, workflowSession.id, readBackConfirmItem.item_id]
          );
          updates.push({
            item_id: readBackConfirmItem.item_id,
            status: "completed",
            confidence: 1,
            extracted_value: true,
            source_text: transcript,
            alternatives: [],
          });
        }
      }

      // The customer just gave the final read-back affirmative (e.g. "Confirm
      // all information is correct" completing — its completion_trigger is
      // 'customer'-only, so reaching here already means the customer said it,
      // not the agent reciting the script). Auto-promote every OTHER still-
      // pending correction candidate in the same breath: the caller already
      // reviewed and accepted the WHOLE updated summary (which folds in every
      // pending correction — see buildReadBackSuggestion's callers), not just
      // the read-back item by itself. Without this, each correction would
      // still need its own separate "please confirm" exchange even after the
      // caller already said the whole thing looks right.
      //
      // A correction candidate is identified the same way isReadBackStage's
      // slot check is: a "suggested" slot whose slot_name ALREADY has a value
      // in slots_filled. A genuine first-time low-confidence suggestion has
      // no slots_filled entry yet, so it is deliberately NOT swept up here —
      // it still needs its own individual confirmation.
      const readBackJustConfirmed = updates.some((u) => {
        if (u.status !== "completed") return false;
        const completedItem =
          analyzerItems.find((p) => p.item_id === u.item_id) ||
          pendingItems.find((p) => p.item_id === u.item_id);
        return (
          completedItem &&
          isReadBackItem({
            itemType: completedItem.type,
            itemLabel: completedItem.label,
            itemPromptHint: completedItem.prompt_hint,
            itemHints: completedItem.hints,
          })
        );
      });

      if (readBackJustConfirmed) {
        const { rows: pendingCorrectionRows } = await client.query(
          `SELECT i.id as item_id, i.slot_name, ist.extracted_value, ist.confidence_score
             FROM aa_workflow_item_status ist
             JOIN aa_workflow_items i ON i.id = ist.item_id
            WHERE ist.session_id = $1 AND ist.status = 'suggested' AND i.type = 'slot'`,
          [workflowSession.id]
        );
        for (const row of pendingCorrectionRows) {
          if (!row.slot_name) continue;
          if (!hasMeaningfulExtractedValue(slotsFilled[row.slot_name])) continue; // not a correction candidate
          if (!hasMeaningfulExtractedValue(row.extracted_value)) continue;
          await client.query(
            `UPDATE aa_workflow_item_status
               SET status = 'completed', completed_at = NOW(), completed_by = $1,
                   alternatives = NULL, updated_at = NOW()
             WHERE session_id = $2 AND item_id = $3`,
            [speakerType || "customer", workflowSession.id, row.item_id]
          );
          slotsFilled[row.slot_name] = row.extracted_value;
          slotsDelta[row.slot_name] = row.extracted_value;
          updates.push({
            item_id: row.item_id,
            status: "completed",
            confidence: row.confidence_score,
            extracted_value: row.extracted_value,
            source_text: transcript,
            alternatives: [],
          });
        }
      }

      // Persist ONLY the slots this request changed, jsonb-merged into whatever
      // the row currently holds — never overwrite the whole object. This is
      // atomic at the DB level, so a concurrent analyze that filled a DIFFERENT
      // slot is preserved instead of clobbered. Re-read the merged result so the
      // response reflects the true post-merge state (including a concurrent
      // request's slots), not just this request's local snapshot.
      if (Object.keys(slotsDelta).length > 0) {
        const { rows: [merged] } = await client.query(
          `UPDATE aa_workflow_sessions
           SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
               updated_at = NOW()
           WHERE id = $2
           RETURNING slots_filled`,
          [JSON.stringify(slotsDelta), workflowSession.id]
        );
        if (merged?.slots_filled && typeof merged.slots_filled === "object") {
          for (const key of Object.keys(slotsFilled)) delete slotsFilled[key];
          Object.assign(slotsFilled, merged.slots_filled);
        }
      }

      // Deterministic name reconciliation. Per-utterance analysis with the
      // "current focus" tie-breaker can drop a lone surname into a `*_first_name`
      // slot (e.g. the agent asks "first name?" and STT yields the family name),
      // leaving first === last (both "Thompson"). Equal first/last is virtually
      // never a real person, so clear the first-name slot and reset its status so
      // the agent re-asks for the given name. Only the unambiguous duplicate case
      // is auto-corrected: a full name mis-dumped into one slot is left to the
      // prompt, because "Mary Jo" is a valid two-word first name that must not be
      // split. Runs AFTER the merge on the freshest state, and each clear is a
      // SINGLE atomic UPDATE guarded on the LIVE DB still showing first === last —
      // so a concurrent request that just captured the correct first name is never
      // wiped (the guard fails and we skip). Self-heals a duplicate created on an
      // earlier utterance since it scans the whole slot set.
      for (const key of Object.keys(slotsFilled)) {
        if (!key.endsWith("_first_name")) continue;
        const lastKey = `${key.slice(0, -"_first_name".length)}_last_name`;
        const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
        if (!(norm(slotsFilled[key]) && norm(slotsFilled[key]) === norm(slotsFilled[lastKey]))) continue;
        // A shared no-info sentinel ("N/A"/"unknown") in both slots is a valid
        // "caller doesn't know the name", not a duplicate surname — leave it.
        if (NAME_DUP_SENTINELS.has(norm(slotsFilled[key]))) continue;

        // Atomic + conditional: only drop the first-name key if the DB STILL shows
        // it equal to the last name. If a concurrent analyze corrected it, the
        // WHERE matches nothing and we leave the fresh value alone.
        const { rows: clearedSession } = await client.query(
          `UPDATE aa_workflow_sessions
              SET slots_filled = slots_filled - $2, updated_at = NOW()
            WHERE id = $1
              AND (slots_filled->>$2) IS NOT NULL
              AND lower(btrim(slots_filled->>$2)) = lower(btrim(slots_filled->>$3))
            RETURNING id`,
          [workflowSession.id, key, lastKey]
        );
        if (clearedSession.length === 0) continue; // concurrent correction won

        slotsFilled[key] = null; // response carries null -> client merges -> re-asks
        const { rows: cleared } = await client.query(
          `UPDATE aa_workflow_item_status ist
              SET status = 'pending', extracted_value = NULL, completed_at = NULL,
                  confidence_score = NULL, source_transcript = NULL,
                  alternatives = NULL, completed_by = NULL, updated_at = NOW()
             FROM aa_workflow_items i
            WHERE ist.item_id = i.id AND ist.session_id = $1 AND i.slot_name = $2
            RETURNING ist.item_id`,
          [workflowSession.id, key]
        );
        for (const row of cleared) {
          updates.push({
            item_id: row.item_id,
            status: "pending",
            extracted_value: null,
            cleared_reason: "name_first_equals_last",
          });
        }
      }

      // Recalculate completion percentage
      const { rows: [stats] } = await client.query(
        `SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed
         FROM aa_workflow_item_status
         WHERE session_id = $1`,
        [workflowSession.id]
      );

      const completionPercentage = stats.total > 0 
        ? Math.round((stats.completed / stats.total) * 100)
        : 0;

      await client.query(
        `UPDATE aa_workflow_sessions 
         SET completion_percentage = $1, updated_at = NOW()
         WHERE id = $2`,
        [completionPercentage, workflowSession.id]
      );

      // Check if workflow is complete
      if (completionPercentage === 100) {
        await client.query(
          `UPDATE aa_workflow_sessions 
           SET status = 'completed', completed_at = NOW()
           WHERE id = $1`,
          [workflowSession.id]
        );
      }

      await client.query("COMMIT");

      workflowLogger.info("workflow_analysis_completed", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.interaction_id,
        workflowId: workflowSession.workflow_id,
        updates: updates.length,
        completionPercentage,
        speaker: speaker || null,
        transcriptLength: transcript.length,
        confidenceThreshold,
      }));

      return NextResponse.json({
        ok: true,
        updates,
        slotsFilled,
        completionPercentage,
        intent: analysisResult.detected_intent,
        sentiment: analysisResult.sentiment,
        sentimentScore: analysisResult.sentiment_score,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to analyze transcript" },
      { status: 500 }
    );
  }
}
