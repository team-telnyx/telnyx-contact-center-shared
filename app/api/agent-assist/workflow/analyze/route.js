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
import { isReadBackItem } from "@/lib/agent-assist/readback.mjs";
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
    const analyzerItems = [...relevantPendingItems, ...completedNotesItems];

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

    // Get current slots filled. `slotsFilled` is the snapshot read at request
    // start; `slotsDelta` accumulates ONLY the slots this request changes, so the
    // persist can jsonb-merge the delta instead of overwriting the whole object.
    // Overwriting is a lost-update race: when analyze is slow, two requests
    // overlap, each reads this snapshot, and the later write wipes the earlier
    // one's slots (e.g. a freshly captured `other_aircraft_responding: false`
    // vanishes, so the suggested response re-targets an already-filled slot).
    const slotsFilled = workflowSession.slots_filled || {};
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

    // The slot the agent is currently collecting = the earliest still-open slot
    // (pendingItems are ordered by stage, then item). Passed to the analyzer so
    // an ambiguous answer is assigned to the slot actually being asked, instead
    // of a same-looking slot elsewhere (e.g. a mis-heard destination facility
    // going into a patient-name slot).
    const currentTargetItem = pendingItems.find(
      (i) => i.type === "slot" && i.current_status === "pending"
    );
    const currentTarget = currentTargetItem
      ? { label: currentTargetItem.label, slotName: currentTargetItem.slot_name }
      : null;

    // Call LLM analyzer (using workflow's configured model)
    const analysisResult = await analyzeWorkflowTranscript({
      transcript,
      speaker: speaker || "unknown",
      pendingItems: analyzerItems,
      slotsFilled,
      model: llmModel,
      includeIntent: assistConfig.enable_intent_recognition === true,
      includeSentiment: assistConfig.enable_sentiment_analysis === true,
      confidenceThreshold,
      currentTarget,
      recentContext: Array.isArray(recentContext) ? recentContext.slice(-6) : [],
      bleedGuardSlot,
    });

    // Process completed items
    const updates = [];
    const client = await pool.connect();
    
    try {
      await client.query("BEGIN");

      for (const completed of analysisResult.completed_items || []) {
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
