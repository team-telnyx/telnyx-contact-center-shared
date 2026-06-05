import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const userStatusPath = new URL("../lib/contact-center/user-status.js", import.meta.url);
const timeoutPath = new URL("../lib/contact-center/agent-answer-timeout.js", import.meta.url);
const monitorPagePath = new URL("../app/(portal)/supervisor/monitor/page.jsx", import.meta.url);

async function source(url) {
  return readFile(url, "utf8");
}

test("manual Available auto-offer broadcasts final persisted Busy instead of stale Available", async () => {
  const src = await source(userStatusPath);

  const statusChangeAvailableIndex = src.lastIndexOf('if (status === "Available")');
  const supervisorBroadcastIndex = src.indexOf('`monitor:${supervisor.id}`', statusChangeAvailableIndex);
  const offerBlock = src.slice(statusChangeAvailableIndex, supervisorBroadcastIndex);

  assert.match(
    offerBlock,
    /offerQueuedCallForAgent\(\{ userId: String\(userId\) \}\)/,
    "manual Available should still immediately offer queued calls",
  );
  assert.match(
    offerBlock,
    /getPersistedAgentStatus\(String\(userId\)\)/,
    "after auto-offering, setUserStatus must re-read cc_agent_state before broadcasting",
  );
  assert.match(
    src,
    /const broadcastStatus\s*=\s*persistedCurrentStatus \|\| status/,
    "broadcast payloads should use the final persisted status, not the originally requested status",
  );
  assert.doesNotMatch(
    src,
    /type:\s*"status_changed",\s*\n\s*status,\s*\n\s*userId:/,
    "status_changed broadcasts must not blindly send the stale requested status after routing may have marked Busy",
  );
});

test("agent no-answer timeout broadcasts agent-call removal for supervisor expanded rows", async () => {
  const timeoutSource = await source(timeoutPath);

  const timeoutSuccessBlock = timeoutSource.slice(
    timeoutSource.indexOf("// Remove from agent's active calls in state manager"),
    timeoutSource.indexOf("console.log(\n    `[AgentAnswerTimeout] Successfully re-enqueued interaction"),
  );

  assert.match(
    timeoutSource,
    /broadcastAgentCallsChanged/,
    "timeout/requeue must have a targeted broadcast helper for supervisor expanded agent rows",
  );
  assert.match(
    timeoutSuccessBlock,
    /broadcastAgentCallsChanged\([\s\S]*reason:\s*"agent_answer_timeout"/,
    "after requeue/removal, timeout handler must tell supervisors which agent call list changed",
  );
  assert.match(
    timeoutSuccessBlock,
    /previousAgentUserId:\s*agentUserId/,
    "broadcast payload must identify the previous agent so UI can remove the stale ringing row",
  );
});

test("supervisor monitor invalidates expanded agent active-call cache on status and interaction changes", async () => {
  const pageSource = await source(monitorPagePath);

  assert.match(
    pageSource,
    /const loadAgentCallsRef = useRef\(null\)/,
    "SSE handlers need a stable ref to force refresh expanded agent calls",
  );
  assert.match(
    pageSource,
    /async function loadAgentCalls\(userId,\s*\{\s*force\s*=\s*false,\s*silent\s*=\s*false\s*\}\s*=\s*\{\}\)/,
    "loadAgentCalls must support force refresh instead of always returning cached active calls",
  );
  assert.match(
    pageSource,
    /function invalidateExpandedAgentCalls\([\s\S]*setAgentActiveCallsMap[\s\S]*loadAgentCallsRef\.current\(String\(userId\), \{ force: true, silent: true \}\)/,
    "monitor should clear and force-refetch expanded calls for affected agents",
  );
  assert.match(
    pageSource,
    /status_changed[\s\S]*invalidateExpandedAgentCalls\(update\.userId/,
    "Agent Not Answering/Available status changes must invalidate the expanded agent call list",
  );
  assert.match(
    pageSource,
    /interaction_updated[\s\S]*previousAgentUserId[\s\S]*invalidateExpandedAgentCalls\(update\.previousAgentUserId/,
    "interaction requeue/removal updates must remove stale calls from the previous expanded agent",
  );
});
