import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeAgentAssistSuggestions,
  mergeAgentAssistTranscriptions,
} from "../lib/agent-assist/history-merge.mjs";

test("queue-transfer transcription saves append agent segments and update redeliveries", () => {
  const firstAgent = [
    {
      id: "customer-1",
      transcript: "I need help",
      track: "inbound",
      isFinal: true,
      timestamp: "2026-08-06T10:00:00.000Z",
    },
  ];
  const secondAgent = [
    {
      id: "agent-2",
      transcript: "I have the history.",
      track: "outbound",
      isFinal: true,
      timestamp: "2026-08-06T10:01:00.000Z",
    },
  ];

  assert.deepEqual(
    mergeAgentAssistTranscriptions(firstAgent, secondAgent).map((item) => item.id),
    ["customer-1", "agent-2"],
  );
  assert.equal(
    mergeAgentAssistTranscriptions(firstAgent, [
      { ...firstAgent[0], transcript: "I need help with an order" },
    ])[0].transcript,
    "I need help with an order",
  );
});

test("workflow suggestion history remains cumulative across agent segments", () => {
  const merged = mergeAgentAssistSuggestions(
    [{ id: "suggestion-1", text: "Ask for the order number" }],
    [{ id: "suggestion-2", text: "Confirm the delivery address" }],
  );
  assert.deepEqual(merged.map((item) => item.id), ["suggestion-1", "suggestion-2"]);
});

test("server history coalesces adjacent finals with the same browser semantics", () => {
  const merged = mergeAgentAssistTranscriptions(
    [
      {
        id: "turn-1",
        transcriptionKey: "turn-1",
        transcript: "Good morning.",
        track: "outbound",
        isFinal: true,
        timestamp: "2026-08-06T10:00:00.000Z",
      },
    ],
    [
      {
        id: "turn-2",
        transcriptionKey: "turn-2",
        transcript: "How can I help?",
        track: "outbound",
        isFinal: true,
        timestamp: "2026-08-06T10:00:02.000Z",
      },
    ],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "turn-1");
  assert.equal(merged[0].transcript, "Good morning. How can I help?");
});

test("browser-expanded final replaces its server fragment without duplicating the tail", () => {
  const merged = mergeAgentAssistTranscriptions(
    [
      {
        id: "turn-1",
        transcriptionKey: "turn-1",
        transcript: "Good morning.",
        track: "outbound",
        isFinal: true,
        timestamp: "2026-08-06T10:00:00.000Z",
      },
      {
        id: "turn-2",
        transcriptionKey: "turn-2",
        transcript: "How can I help?",
        track: "outbound",
        isFinal: true,
        timestamp: "2026-08-06T10:00:02.000Z",
      },
    ],
    [
      {
        id: "turn-1",
        transcriptionKey: "turn-1",
        transcript: "Good morning. How can I help?",
        track: "outbound",
        isFinal: true,
        timestamp: "2026-08-06T10:00:02.000Z",
      },
    ],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].transcript, "Good morning. How can I help?");
});

test("queue transfer persists before enqueue and hydrates the destination agent", () => {
  const modal = readFileSync("components/contact-center/TransferModal.jsx", "utf8");
  const workflow = readFileSync("components/contact-center/AgentAssistWorkflow.jsx", "utf8");
  const sessionRoute = readFileSync(
    "app/api/agent-assist/workflow/session/route.js",
    "utf8",
  );
  const transcriptionRoute = readFileSync(
    "app/api/contact-center/interactions/[id]/transcription/route.js",
    "utf8",
  );
  const transcriptionPersistence = readFileSync(
    "lib/agent-assist/transcription-persistence.mjs",
    "utf8",
  );

  assert.match(modal, /transferType === "queue"/);
  assert.match(modal, /syncAgentAssistToDb\(\)/);
  assert.match(sessionRoute, /agent_assist_history/);
  assert.match(workflow, /hydrateTranscriptions\(previousTranscriptions\)/);
  assert.match(workflow, /transcription\.historyHydrated === true/);
  assert.match(transcriptionRoute, /FOR UPDATE/);
  assert.match(transcriptionRoute, /persistAgentAssistTranscriptionsInTransaction/);
  assert.match(transcriptionPersistence, /mergeAgentAssistTranscriptions/);
});
