import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { matchesAgentRecitation } from "../lib/agent-assist/readback.mjs";
import useActiveCallStore from "../lib/stores/active-call-store.js";

// the reference workflow feedback, Aug 12 testing session. Three asks in one flow:
//   1. the confirmation summary reads as one narrative sentence (covered in
//      agent-assist-readback.test.mjs),
//   2. the confirmation moves on once the AGENT speaks it,
//   3. the final boolean slot ("other aircraft responding?") actually fills
//      when the customer answers "No." to both closing questions — before
//      this, the second bare "No." was swallowed before analysis, which is
//      what delayed the confirmation.

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

const INTAKE_SLOTS = {
  patient_name: "Marcus Webb",
  patient_dob: "1958-06-15",
  patient_weight: "198 lbs",
  pickup_facility: "Maplewood Regional Medical Center",
  pickup_department: "Emergency Department",
  destination_facility: "Riverside Medical",
  destination_department: "Cath Lab",
  transport_reason: "STEMI Alert",
  iv_count: 2,
  accompanying: true,
  weather_declined: false,
  other_aircraft: false,
  trip_notes: "STEMI patient. Aspirin given, heparin drip running. Wife accompanying.",
  callback_number: "9405550192",
};

test("a full recitation of the summary matches", () => {
  const recitation =
    "We are transferring Marcus Webb, DOB June fifteenth, one ninety eight pounds, from " +
    "Maplewood Regional Medical Center Emergency Department to Riverside Medical Cath Lab, " +
    "reason STEMI Alert, two IV drips, companion yes, notes STEMI patient aspirin given " +
    "heparin drip running wife accompanying, EMS contact nine four zero.";
  assert.equal(matchesAgentRecitation(recitation, INTAKE_SLOTS), true);
});

test("STT noise in single words of multi-word values does not break the match", () => {
  // "Web" for Webb, "Medico" for Medical — half-token per-value tolerance
  // holds on the intact discriminating words; every summary FIELD is read.
  const noisy =
    "We are transferring Marcus Web, from Maplewood Regional Medical Center Emergency " +
    "Department to Riverside Medico Cath Lab, reason STEMI Alert, notes STEMI patient " +
    "aspirin given heparin drip running wife accompanying.";
  assert.equal(matchesAgentRecitation(noisy, INTAKE_SLOTS), true);
});

test("an abbreviated route check does not complete the recitation (Codex 4th pass on #1367)", () => {
  // Names the patient, both facilities and both departments — but never
  // reads the reason or the notes. Coverage of the summary's fields, not a
  // fixed value count, is the bar.
  assert.equal(
    matchesAgentRecitation(
      "Marcus Webb is going from Maplewood Regional Medical Center Emergency Department to Riverside Medical Cath Lab, right?",
      INTAKE_SLOTS
    ),
    false
  );
});

test("shared generic tokens are not evidence: the Codex attack sentence does not match", () => {
  // One "hospital" must not count for two facility values, and a short
  // whole-word value ("ICU") plus generic overlap must stay short of the bar.
  assert.equal(
    matchesAgentRecitation(
      "Which ICU room at the hospital should we route the patient to today?",
      { caller_facility: "Summit Hospital", destination_facility: "General Hospital", pickup_department: "ICU" }
    ),
    false
  );
});

test("a follow-up question naming two or three captured values is not a recitation", () => {
  assert.equal(
    matchesAgentRecitation(
      "So pickup is Maplewood Regional Medical Center going to Riverside Medical, Cath Lab, is that the plan?",
      INTAKE_SLOTS
    ),
    false
  );
});

test("ordinary agent speech naming one value is NOT a recitation", () => {
  assert.equal(matchesAgentRecitation("And what's the room number at Riverside Medical?", INTAKE_SLOTS), false);
  assert.equal(matchesAgentRecitation("Okay. Great. Let me get that sorted for you today.", INTAKE_SLOTS), false);
  assert.equal(matchesAgentRecitation("Thanks for calling, how can I help you today?", INTAKE_SLOTS), false);
});

test("short utterances never match, whatever they contain", () => {
  assert.equal(matchesAgentRecitation("Marcus Webb, Riverside Medical, Maplewood.", INTAKE_SLOTS), false);
});

test("booleans and N/A sentinels are not distinctive values", () => {
  // A slots map of only booleans/sentinels can never produce a match.
  assert.equal(
    matchesAgentRecitation(
      "Yes no none unknown and that is everything we have for the record today, thank you.",
      { a: true, b: false, c: "N/A", d: "none" }
    ),
    false
  );
});

test("the analyze route completes the recitation deterministically on the agent's utterance", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /if \(isReadBackStage && speakerType === "agent"\) \{/);
  assert.match(route, /item\.completion_trigger === "agent" &&\s*\n\s*isReadBackItem\(/);
  // Both backstop lookups search the UNSCOPED item list — in a multi-group
  // batch the utterance is classified by its content while the Confirmation
  // items live in their own group, so a scoped lookup finds nothing (Codex
  // P1 on #1367).
  const agentLookups = route.match(/const recitationItem = allPendingItems\.find\(/g) || [];
  const customerLookups = route.match(/const readBackConfirmItem = allPendingItems\.find\(/g) || [];
  assert.equal(agentLookups.length, 1);
  assert.equal(customerLookups.length, 1);
  assert.doesNotMatch(route, /const recitationItem = pendingItems\.find\(/);
  assert.doesNotMatch(route, /const readBackConfirmItem = pendingItems\.find\(/);
  assert.match(route, /matchesAgentRecitation\(transcript, slotsFilled\)/);
  // Guarded write, agent attribution, never the customer's sign-off marker.
  assert.match(route, /workflow_recitation_autocompleted/);
  const hook = route.slice(route.indexOf('workflow_recitation_autocompleted') - 3200, route.indexOf('workflow_recitation_autocompleted'));
  assert.match(hook, /AND status IN \('pending', 'suggested'\)/);
  assert.match(hook, /completed_by = 'agent'/);
  assert.doesNotMatch(hook, /completed_by = 'customer'/);
  // The write goes through the transaction connection — analyzeOneUtterance
  // has no bare `client` in scope post-#1365, and a ReferenceError on the
  // success path would roll back the whole analysis (Codex P1 on #1367).
  // The outer POST handler has its own legitimate `client`, so the
  // no-bare-client assertion is scoped to analyzeOneUtterance's body.
  assert.match(hook, /await connectionRef\.client\.query\(/);
  const fnStart = route.indexOf("async function analyzeOneUtterance");
  const fnEnd = route.indexOf("async function", fnStart + 1);
  assert.ok(fnStart > -1 && fnEnd > fnStart);
  assert.doesNotMatch(route.slice(fnStart, fnEnd), /await client\.query\(/);
  // A same-turn LOW-CONFIDENCE suggestion of the recitation must not
  // suppress the deterministic matcher — only a completed update counts as
  // handled, and a superseded suggested entry is dropped from the response.
  assert.match(hook, /u\.status === "completed"/);
  assert.match(hook, /updates\.splice\(supersededIndex, 1\)/);
});

test("customer-owned semantics unchanged: affirmative backstop and promotion sweep still key on the customer", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /if \(isReadBackStage && speakerType === "customer"\) \{/);
  assert.match(route, /completion_trigger === "customer" &&\s*\n\s*isReadBackItem\(/);
});

// --- The final-boolean fix -------------------------------------------------

function resetStore() {
  useActiveCallStore.setState({
    call: { id: "test-call" },
    originalCallControlId: "cc-1",
    transcriptions: [],
  });
}

const addFinal = (over) =>
  useActiveCallStore.getState().addTranscription({
    call_control_id: "cc-1",
    is_final: true,
    speech_final: true,
    ...over,
  });

test("a second bare 'No.' seconds later survives even when the agent's question bubble is missing", () => {
  resetStore();
  // Customer answers the weather question.
  addFinal({ transcription_track: "inbound", transcription_key: "c1", transcript: "No." });
  // The agent asks the aircraft question, but the outbound bubble is LATE —
  // nothing lands in the store. Age the first answer past the machine window.
  useActiveCallStore.setState((state) => ({
    transcriptions: state.transcriptions.map((t) => ({
      ...t,
      timestamp: new Date(Date.now() - 5000).toISOString(),
    })),
  }));
  // Customer answers the aircraft question with the same bare word — ADJACENT
  // to the first answer. Before this fix the unconditional adjacent-equal
  // dedupe swallowed it and other_aircraft never filled.
  addFinal({ transcription_track: "inbound", transcription_key: "c2", transcript: "No." });

  const rows = useActiveCallStore.getState().transcriptions;
  assert.equal(rows.length, 2, "both answers are real turns");
});

test("a true machine redelivery of the same bare final within the tight window is still dropped", () => {
  resetStore();
  addFinal({ transcription_track: "inbound", transcription_key: "c1", transcript: "No." });
  addFinal({ transcription_track: "inbound", transcription_key: "c1b", transcript: "No." });
  assert.equal(useActiveCallStore.getState().transcriptions.length, 1);
});

test("a repeated bare answer arriving interim-first survives its own finalization (Codex P1 on #1367)", () => {
  resetStore();
  addFinal({ transcription_track: "inbound", transcription_key: "c1", transcript: "No." });
  // Age the first answer past the machine window but inside the 3.5s
  // coalesce window — the exact interval the review flagged.
  useActiveCallStore.setState((state) => ({
    transcriptions: state.transcriptions.map((t) => ({
      ...t,
      timestamp: new Date(Date.now() - 3000).toISOString(),
    })),
  }));
  // Second answer arrives as an interim first, then finalizes on the same key.
  useActiveCallStore.getState().addTranscription({
    call_control_id: "cc-1",
    transcription_track: "inbound",
    transcription_key: "c2",
    transcript: "No.",
    is_final: false,
  });
  addFinal({ transcription_track: "inbound", transcription_key: "c2", transcript: "No." });

  const rows = useActiveCallStore.getState().transcriptions;
  assert.equal(rows.length, 2, "the finalized second answer must not be coalesced away");
  assert.equal(rows[1].isFinal, true);
});

test("the repeated bare answer is not silently coalesced into the previous row either", () => {
  resetStore();
  addFinal({ transcription_track: "inbound", transcription_key: "c1", transcript: "No." });
  useActiveCallStore.setState((state) => ({
    transcriptions: state.transcriptions.map((t) => ({
      ...t,
      timestamp: new Date(Date.now() - 3000).toISOString(),
    })),
  }));
  addFinal({ transcription_track: "inbound", transcription_key: "c2", transcript: "No." });
  const rows = useActiveCallStore.getState().transcriptions;
  // Two rows with distinct ids — a coalesce would have merged to one row
  // with unchanged text, and the analysis effect (keyed on id+text) would
  // never re-fire for the second answer.
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
});

test("server: a bare customer yes/no refocuses onto the boolean the agent just asked about", async () => {
  const route = await read("../app/api/agent-assist/workflow/analyze/route.js");
  assert.match(route, /BARE_YES_NO_RE/);
  assert.match(route, /workflow_bare_answer_focus_override/);
  // Only booleans, only pending/suggested, keyed on the last AGENT context line.
  const block = route.slice(route.indexOf("BARE_YES_NO_RE"), route.indexOf("workflow_bare_answer_focus_override"));
  assert.match(block, /i\.slot_type !== "boolean"/);
  assert.match(block, /"inbound"/);
});
