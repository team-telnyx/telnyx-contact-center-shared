import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import useActiveCallStore from "../lib/stores/active-call-store.js";
import { normalizeTranscriptForDedup } from "../lib/agent-assist/transcription-turns.mjs";

// an earlier fix follow-up ("duplicate entries again", the reference workflow retest Aug 11). Frame-by-
// frame review of the session showed two shapes, both NON-adjacent — the other
// speaker's bubble always sat between the copies:
//   1. growing-prefix cascades: every interim of one utterance kept as its own
//      finalized bubble ("I did I" / "I did... I I" / ... / full sentence),
//   2. exact-duplicate finals ("You wanna repeat that number?" twice, same
//      STT confidence, separated by one customer bubble).
// Every client dedupe compared against ONLY the last array element, so any
// interleaving defeated all of them.

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

function reset() {
  useActiveCallStore.setState({
    call: { id: "test-call" },
    originalCallControlId: "cc-1",
    transcriptions: [],
  });
}

const add = (over) =>
  useActiveCallStore.getState().addTranscription({
    call_control_id: "cc-1",
    is_final: true,
    speech_final: true,
    ...over,
  });

const rows = () => useActiveCallStore.getState().transcriptions;

test("growing-prefix cascade across cross-talk collapses to one bubble per utterance", () => {
  reset();
  // The exact interleave pattern from the session: each agent fragment arrives
  // under a NEW key (rotated server-side), separated by customer bubbles.
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "I did I" });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Curious." });
  add({ transcription_track: "outbound", transcription_key: "a2", transcript: "I did I I" });
  add({ transcription_track: "inbound", transcription_key: "c2", transcript: "Curious." });
  add({ transcription_track: "outbound", transcription_key: "a3", transcript: "I did I I I did a test with HJ and it went very well." });

  const agentRows = rows().filter((t) => t.track === "outbound");
  const customerRows = rows().filter((t) => t.track === "inbound");
  assert.equal(agentRows.length, 1, "agent fragments must collapse into one bubble");
  assert.equal(agentRows[0].transcript, "I did I I I did a test with HJ and it went very well.");
  assert.equal(customerRows.length, 1, "the repeated customer line must render once");
});

test("an exact duplicate final separated by an opposing bubble is dropped", () => {
  reset();
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "You wanna repeat that number?" });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "I don't know why." });
  add({ transcription_track: "outbound", transcription_key: "a2", transcript: "You wanna repeat that number?" });

  assert.equal(rows().length, 2);
  assert.deepEqual(
    rows().map((t) => t.transcript),
    ["You wanna repeat that number?", "I don't know why."]
  );
});

test("a late shorter replay of an already-rendered utterance is dropped", () => {
  reset();
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "Okay. Patient, Jordan Rivera. Destination, Lakeview." });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Yeah. Yeah." });
  add({ transcription_track: "outbound", transcription_key: "a2", transcript: "Okay. Patient, Jordan Rivera. Destination, Lakeview" });

  assert.equal(rows().filter((t) => t.track === "outbound").length, 1);
});

test("a deliberate re-ask of the same sentence seconds later still renders (Codex P1 on #1362)", () => {
  reset();
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "Could you repeat the number?" });
  // Age the first ask past the exact-duplicate window — the listener's
  // unclear answer plus the re-ask itself always takes longer than the
  // couple of seconds a redundant-source copy needs to arrive.
  useActiveCallStore.setState((state) => ({
    transcriptions: state.transcriptions.map((t) => ({
      ...t,
      timestamp: new Date(Date.now() - 6000).toISOString(),
    })),
  }));
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Three one two, then static." });
  add({ transcription_track: "outbound", transcription_key: "a2", transcript: "Could you repeat the number?" });

  const agentRows = rows().filter((t) => t.track === "outbound");
  assert.equal(agentRows.length, 2, "an intentional repeat past the window is a real turn");
});

// Verified this session: textContinues is a plain string-prefix check with NO
// word-boundary awareness ("north wing".startsWith("no") is literally true).
// The continuation-replace branch that collapses a growing-prefix cascade had
// no substance/timing gate at all (unlike its exact-duplicate/tail-repeat
// siblings), so a short, real, standalone utterance ("No.") could be silently
// absorbed into an UNRELATED later utterance from the same speaker that
// merely starts with the same letters — erasing the real earlier answer.
test("a short standalone answer is NOT silently absorbed into an unrelated later utterance sharing its prefix", () => {
  reset();
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "No." });
  // Age it past the tight non-adjacent window and interleave the other leg,
  // matching the real pattern (an opposing bubble always sat between the
  // copies in the reported session) — this is a genuinely separate later
  // utterance, not a growing STT hypothesis of "No.".
  useActiveCallStore.setState((state) => ({
    transcriptions: state.transcriptions.map((t) => ({
      ...t,
      timestamp: new Date(Date.now() - 6000).toISOString(),
    })),
  }));
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "What about the callback number?" });
  add({ transcription_track: "inbound", transcription_key: "c2", transcript: "Not sure about that." });

  const customerRows = rows().filter((t) => t.track === "inbound");
  assert.equal(customerRows.length, 2, "the standalone \"No.\" must survive as its own turn");
  assert.deepEqual(
    customerRows.map((t) => t.transcript),
    ["No.", "Not sure about that."]
  );
});

test("the growing-prefix cascade collapse still fires for RAPID, adjacent same-utterance fragments (no regression from the prefix fix)", () => {
  reset();
  // Rapid-fire growing STT hypotheses of ONE utterance, no opposing-leg
  // bubble between them — the common case the cascade-collapse exists for.
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "I" });
  add({ transcription_track: "inbound", transcription_key: "c2", transcript: "I did" });
  add({ transcription_track: "inbound", transcription_key: "c3", transcript: "I did the paperwork" });

  const customerRows = rows().filter((t) => t.track === "inbound");
  assert.equal(customerRows.length, 1, "rapid adjacent growth of one utterance must still collapse to one bubble");
  assert.equal(customerRows[0].transcript, "I did the paperwork");
});

test("a genuinely repeated short backchannel still renders twice", () => {
  reset();
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Yeah." });
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "Right." });
  add({ transcription_track: "inbound", transcription_key: "c2", transcript: "Yeah." });

  assert.equal(rows().length, 3, "short backchannels are real repeats, not STT duplicates");
});

test("an open bubble interrupted by the other leg keeps absorbing ITS OWN utterance's growth", () => {
  reset();
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "It's not big", is_final: false, speech_final: false });
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "Yeah." });
  // Same key, same utterance grown — the turn-boundary guard must NOT split
  // this into a finalized fragment plus a fresh bubble.
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "It's not big enough for some reason.", is_final: false, speech_final: false });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "It's not big enough for some reason.", is_final: true, speech_final: true });

  const customerRows = rows().filter((t) => t.track === "inbound");
  assert.equal(customerRows.length, 1, "one utterance, one bubble, despite the interruption");
  assert.equal(customerRows[0].transcript, "It's not big enough for some reason.");
  assert.equal(customerRows[0].isFinal, true);
});

test("the turn-boundary split still fires for genuinely NEW text under a reused key", () => {
  reset();
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "weighs around one hundred fifty pounds", is_final: false, speech_final: false });
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "What will be the facility name for the pickup?" });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Northgate Presbyterian Hospital", is_final: false, speech_final: false });

  const customerRows = rows().filter((t) => t.track === "inbound");
  assert.equal(customerRows.length, 2, "unrelated text must still start a fresh bubble");
  assert.equal(customerRows[0].isFinal, true, "the stale bubble is closed");
});

test("a phantom interim repeating a recent final across an opposing bubble is suppressed", () => {
  reset();
  add({ transcription_track: "outbound", transcription_key: "a1", transcript: "Thanks for calling. How can I help you today?" });
  add({ transcription_track: "inbound", transcription_key: "c1", transcript: "Hi there." });
  const before = rows().length;
  add({ transcription_track: "outbound", transcription_key: "a2", transcript: "How can I help you today", is_final: false, speech_final: false });
  assert.equal(rows().length, before, "the tail re-announcement must not open a bubble");
});

test("normalizeTranscriptForDedup strips exactly what kept the two sources from matching", () => {
  assert.equal(normalizeTranscriptForDedup("Sara Thompson."), "sara thompson");
  assert.equal(normalizeTranscriptForDedup("  Sara   Thompson!?  "), "sara thompson");
  assert.equal(normalizeTranscriptForDedup(""), "");
  assert.equal(normalizeTranscriptForDedup(null), "");
});

test("the canonical router builds cross-source dedup keys from normalized text for every webhook adapter", async () => {
  const router = await read("../lib/agent-assist-transcription-router.mjs");
  const mediaEvents = await read("../lib/acd/media-events.mjs");

  // Router: keys embed the shared normalization, not raw itrText.
  assert.match(router, /const itrDedup = normalizeTranscriptForDedup\(itrText\);/);
  assert.match(router, /`itr-r:\$\{interaction\.id\}:\$\{ownLeg\}:\$\{itrDedup\}`/);
  assert.match(router, /`itr-w:\$\{interaction\.id\}:\$\{ownLeg\}:\$\{itrDedup\}`/);
  assert.doesNotMatch(router, /`itr-r:\$\{interaction\.id\}:\$\{ownLeg\}:\$\{itrText\}`/);

  // Every Voice API transcription event enters this same router, so there is
  // no second normalizer that can drift from the standalone STT path.
  assert.match(mediaEvents, /return routeAgentAssistTranscription\(payload\)/);
  assert.doesNotMatch(mediaEvents, /normalizeTranscriptForDedup/);

  // Router seeds the rfinal-itr anchor the webhook's tail-suppression reads —
  // previously only the webhook wrote it, so the suppression could never fire
  // when the router broadcast first.
  assert.match(router, /rfinal-itr:\$\{interaction\.id\}:\$\{ownLeg\}/);
});
