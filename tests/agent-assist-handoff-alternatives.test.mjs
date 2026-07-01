import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("ai-handoff-processor.updateWorkflowSessionWithAiData persists alternatives with the agent-authoritative CASE guard", async () => {
  const handoff = await read("../lib/agent-assist/ai-handoff-processor.js");

  // INSERT column list must include `alternatives` after `source_transcript`.
  assert.match(
    handoff,
    /completed_by, source_transcript, alternatives\)/
  );

  // VALUES must bind alternatives as a JSONB parameter ($7 — comes after
  // the existing $1=sessionId, $2=itemId, $3=value, $4=confidence,
  // $5=source_utterance, $6=nextStatus).
  assert.match(handoff, /\$7::jsonb/);

  // ON CONFLICT DO UPDATE must preserve agent-completed rows with the same
  // CASE WHEN completed_by = 'agent' THEN <existing> ELSE $7::jsonb END guard.
  assert.match(
    handoff,
    /alternatives = CASE WHEN aa_workflow_item_status\.completed_by = 'agent' THEN aa_workflow_item_status\.alternatives ELSE \$7::jsonb END/
  );

  // Param must be built from slotData?.alternatives — JSON-stringified when
  // it is a non-empty array, else null (matches the existing JSONB pattern
  // used for slots_filled = $1::jsonb).
  assert.match(
    handoff,
    /Array\.isArray\(slotData\?\.alternatives\) && slotData\.alternatives\.length > 0 \? JSON\.stringify\(slotData\.alternatives\) : null/
  );

  // The existing source_transcript plumbing must remain intact (mirror guard).
  assert.match(
    handoff,
    /source_transcript = CASE WHEN aa_workflow_item_status\.completed_by = 'agent' THEN aa_workflow_item_status\.source_transcript ELSE \$5 END/
  );
});

test("ai-handoff-processor.broadcastAiHandoffToAgent selects st.alternatives and includes alternatives in slotsDetails, normalized to array", async () => {
  const handoff = await read("../lib/agent-assist/ai-handoff-processor.js");

  // statusRows SELECT must include the persisted alternatives column.
  assert.match(handoff, /st\.alternatives/);

  // slotsDetails[key] must include `alternatives`, normalized to an array.
  // Prefer the persisted DB value, fall back to the raw handoff value,
  // default to an empty array.
  assert.match(
    handoff,
    /alternatives:\s*Array\.isArray\(statusRow\?\.alternatives\)\s*\?\s*statusRow\.alternatives\s*:\s*Array\.isArray\(val\?\.alternatives\)\s*\?\s*val\.alternatives\s*:\s*\[\]/
  );

  // The existing source_utterance pass-through must remain intact.
  assert.match(
    handoff,
    /source_utterance:\s*statusRow\?\.source_transcript \?\? val\?\.source_utterance/
  );
});

test("conversation-insights webhook INSERT persists alternatives with the agent-authoritative CASE guard", async () => {
  const route = await read("../app/api/webhooks/telnyx/conversation-insights/route.js");

  // INSERT column list must include `alternatives` after `source_transcript`.
  assert.match(
    route,
    /completed_by, source_transcript, alternatives\)/
  );

  // VALUES must bind alternatives as a JSONB parameter ($6 — comes after
  // the existing $1=sessionId, $2=itemId, $3=value, $4=confidence,
  // $5=source_utterance).
  assert.match(route, /\$6::jsonb/);

  // ON CONFLICT DO UPDATE must preserve agent-completed rows.
  assert.match(
    route,
    /alternatives = CASE WHEN aa_workflow_item_status\.completed_by = 'agent' THEN aa_workflow_item_status\.alternatives ELSE \$6::jsonb END/
  );

  // Param must be built from slotData?.alternatives (non-empty array →
  // JSON-stringified; else null).
  assert.match(
    route,
    /Array\.isArray\(slotData\?\.alternatives\) && slotData\.alternatives\.length > 0 \? JSON\.stringify\(slotData\.alternatives\) : null/
  );

  // The existing source_transcript guard must remain intact.
  assert.match(
    route,
    /source_transcript = CASE WHEN aa_workflow_item_status\.completed_by = 'agent' THEN aa_workflow_item_status\.source_transcript ELSE \$5 END/
  );
});
