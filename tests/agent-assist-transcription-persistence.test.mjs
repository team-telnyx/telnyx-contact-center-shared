import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  persistAgentAssistTranscriptionsInTransaction,
} from "../lib/agent-assist/transcription-persistence.mjs";

test("final server-side transcription is merged into workflow and Core history", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM aa_workflow_sessions")) {
        return {
          rows: [
            {
              id: "session-1",
              transcriptions: [
                {
                  id: "customer-1",
                  transcriptionKey: "customer-1",
                  transcript: "Hello",
                  track: "inbound",
                  isFinal: true,
                },
              ],
            },
          ],
        };
      }
      if (sql.includes("FROM acd_transcripts")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await persistAgentAssistTranscriptionsInTransaction(client, {
    workItemId: "work-1",
    transcriptions: [
      {
        id: "agent-1",
        transcriptionKey: "agent-1",
        transcript: "How can I help?",
        track: "outbound",
        isFinal: true,
      },
    ],
  });

  assert.deepEqual(
    result.mergedTranscriptions.map((item) => item.id),
    ["customer-1", "agent-1"],
  );
  assert.match(queries[0].sql, /FROM acd_work_items WHERE id = \$1 FOR UPDATE/);
  const workflowUpdate = queries.find((query) =>
    query.sql.includes("UPDATE aa_workflow_sessions"),
  );
  assert.ok(workflowUpdate);
  assert.deepEqual(
    JSON.parse(workflowUpdate.params[1]).map((item) => item.transcript),
    ["Hello", "How can I help?"],
  );
  const artifactUpsert = queries.find((query) =>
    query.sql.includes("INSERT INTO acd_transcripts"),
  );
  assert.ok(artifactUpsert);
  assert.equal(artifactUpsert.params[2], "agent-assist-history:work-1");
  assert.equal(artifactUpsert.params[3], "Hello\nHow can I help?");
});

test("history artifact remains cumulative when no workflow session exists", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM aa_workflow_sessions")) return { rows: [] };
      if (sql.includes("FROM acd_transcripts")) {
        return {
          rows: [
            {
              id: "artifact-1",
              segments: [
                {
                  id: "customer-1",
                  transcriptionKey: "customer-1",
                  transcript: "Existing customer turn",
                  track: "inbound",
                  isFinal: true,
                },
              ],
            },
          ],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const result = await persistAgentAssistTranscriptionsInTransaction(client, {
    workItemId: "work-without-session",
    transcriptions: [
      {
        id: "agent-1",
        transcriptionKey: "agent-1",
        transcript: "New agent turn",
        track: "outbound",
        isFinal: true,
      },
    ],
  });

  assert.deepEqual(
    result.mergedTranscriptions.map((item) => item.transcript),
    ["Existing customer turn", "New agent turn"],
  );
  assert.match(
    queries.find((query) => query.sql.includes("FROM acd_transcripts")).sql,
    /FOR UPDATE/,
  );
  assert.equal(
    queries.find((query) => query.sql.includes("INSERT INTO acd_transcripts")).params[3],
    "Existing customer turn\nNew agent turn",
  );
});

test("live transcription router persists each accepted final turn on the server", async () => {
  const routerSource = await readFile(
    new URL("../lib/agent-assist-transcription-router.mjs", import.meta.url),
    "utf8",
  );

  assert.match(routerSource, /if \(isMessageFinal\) \{[\s\S]*persistAgentAssistTranscriptions\(pool/);
  assert.match(routerSource, /transcriptionKey,[\s\S]*isFinal: true,[\s\S]*track,/);
  assert.match(routerSource, /transcription_history_persist_failed/);
});
