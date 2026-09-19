import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWorkflowHistorySuggestions,
  resolveWorkflowHistoryTranscriptions,
} from "../lib/agent-assist/history-transcriptions.mjs";

test("Call History prefers durable workflow-session transcriptions", () => {
  const session = [
    {
      id: "customer-1",
      transcript: "Hello? How are you? Can you hear me?",
      track: "inbound",
      isFinal: true,
    },
    {
      id: "customer-2",
      transcript: "I do not see any transcription from the agent side.",
      track: "inbound",
      isFinal: true,
    },
  ];

  assert.deepEqual(
    resolveWorkflowHistoryTranscriptions({
      sessionTranscriptions: session,
      metadataTranscriptions: [],
    }),
    session,
  );
});

test("slot provenance is never reconstructed as spoken transcript", () => {
  assert.deepEqual(
    resolveWorkflowHistoryTranscriptions({
      sessionTranscriptions: [],
      metadataTranscriptions: [],
      artifactSegments: [],
      stages: [
        {
          items: [
            {
              status: {
                completed_by: "call_flow",
                source_transcript: "client_state.workflow_data",
              },
            },
          ],
        },
      ],
    }),
    [],
  );
});

test("Call History falls back to normalized ACD transcript artifacts", () => {
  assert.deepEqual(
    resolveWorkflowHistoryTranscriptions({
      artifactSegments: [
        { text: "Customer artifact", speaker: "customer", timestamp: "t1" },
        { text: "Agent artifact", speaker: "agent", timestamp: "t2" },
      ],
    }).map(({ transcript, track }) => ({ transcript, track })),
    [
      { transcript: "Customer artifact", track: "inbound" },
      { transcript: "Agent artifact", track: "outbound" },
    ],
  );
});

test("Call History falls back to transcript text when segments are empty", () => {
  assert.deepEqual(
    resolveWorkflowHistoryTranscriptions({
      artifactSegments: [],
      artifactText: "Channel 1: Hello\nChannel 2: How can I help?",
    }).map(({ transcript, track }) => ({ transcript, track })),
    [
      { transcript: "Hello", track: "inbound" },
      { transcript: "How can I help?", track: "outbound" },
    ],
  );
});

test("Call History maps numeric speakers and channel labels to both legs", () => {
  assert.deepEqual(
    resolveWorkflowHistoryTranscriptions({
      artifactSpeakerTurns: [
        { text: "Customer", speaker: 0 },
        { text: "Agent", speaker: 1 },
        { text: "Customer channel", speaker: "channel_1" },
        { text: "Agent channel", speaker: "channel_2" },
      ],
    }).map(({ transcript, track }) => ({ transcript, track })),
    [
      { transcript: "Customer", track: "inbound" },
      { transcript: "Agent", track: "outbound" },
      { transcript: "Customer channel", track: "inbound" },
      { transcript: "Agent channel", track: "outbound" },
    ],
  );
});

test("session suggestions win over stale metadata snapshots", () => {
  const result = resolveWorkflowHistorySuggestions({
    metadataSuggestions: [{ id: "s1", text: "Old" }],
    sessionSuggestions: [{ id: "s1", text: "Current" }],
  });
  assert.equal(result[0].text, "Current");
});
