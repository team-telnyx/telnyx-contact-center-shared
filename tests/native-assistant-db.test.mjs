import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool, seedAgent } from "./helpers/acd-test-db.mjs";
import {
  reserveDirectVoice,
  sweepAbandonedDirectIntents,
} from "../lib/acd/direct-capacity.mjs";
import {
  updateNativeAssistant,
  reconcileNativeAssistants,
} from "../lib/acd/native-assistant.mjs";
import { releaseReservation } from "../lib/acd/reservations.mjs";
import { clearSagaDeadlineWakeups } from "../lib/acd/saga-engine.mjs";
const pool = await prepareAcdTestPool("acd_core_test_native_assistant");
after(async () => {
  clearSagaDeadlineWakeups();
  await pool.end();
});
async function fixture() {
  const agentId = randomUUID(),
    authSessionId = randomUUID();
  await seedAgent(pool, agentId, { sessionId: randomUUID() });
  const intent = await reserveDirectVoice(pool, {
    agentId,
    target: "sip:user@assistant-test.sip.telnyx.com",
    nativeAssistantId: "assistant-test",
    nativeSession: {
      authSessionId,
      deadline: new Date(Date.now() + 60000).toISOString(),
    },
  });
  return { agentId, authSessionId, intent };
}
const reservation = async (id) =>
  (await pool.query("SELECT state FROM acd_reservations WHERE id=$1", [id]))
    .rows[0].state;
test("native AI occupies voice until local media has stopped, then a regular call can start", async () => {
  const { agentId, authSessionId, intent } = await fixture();
  assert.equal(intent.purpose, "native_ai");
  await assert.rejects(
    reserveDirectVoice(pool, { agentId, target: "+15555550100" }),
    { status: 409 },
  );
  await updateNativeAssistant(pool, agentId, {
    id: intent.id,
    state: "active",
    authSessionId,
  });
  assert.equal(
    (
      await pool.query("SELECT state FROM acd_work_items WHERE id=$1", [
        intent.work_item_id,
      ])
    ).rows[0].state,
    "active",
  );
  assert.equal(await reservation(intent.reservation_id), "active");
  await updateNativeAssistant(pool, agentId, {
    id: intent.id,
    state: "ended",
    authSessionId,
  });
  assert.equal(await reservation(intent.reservation_id), "released");
  await updateNativeAssistant(pool, agentId, {
    id: intent.id,
    state: "active",
    authSessionId,
  });
  assert.equal(await reservation(intent.reservation_id), "released");
  const next = await reserveDirectVoice(pool, {
    agentId,
    target: "+15555550100",
  });
  assert.ok(next.id);
});
test("background session expiry does not release native audio; provider duration recovers a crashed client", async () => {
  const { agentId, authSessionId, intent } = await fixture();
  await updateNativeAssistant(pool, agentId, {
    id: intent.id,
    state: "active",
    authSessionId,
  });
  await pool.query(
    "UPDATE acd_agent_sessions SET expires_at=now()-interval '1 minute' WHERE agent_id=$1",
    [agentId],
  );
  await pool.query(
    "UPDATE acd_direct_intents SET created_at=now()-interval '3 minutes' WHERE id=$1",
    [intent.id],
  );
  await sweepAbandonedDirectIntents(pool, {
    provider: {
      send() {
        throw Error("Native AI must not inspect SIP inventory");
      },
    },
  });
  assert.equal(await reservation(intent.reservation_id), "active");
  await reconcileNativeAssistants(pool);
  assert.equal(await reservation(intent.reservation_id), "active");
  await pool.query(
    "UPDATE acd_work_items SET attributes=attributes || jsonb_build_object('native_deadline',(now()-interval '1 second')::text) WHERE id=$1",
    [intent.work_item_id],
  );
  await reconcileNativeAssistants(pool);
  assert.equal(await reservation(intent.reservation_id), "released");
});
test("native intent retries stay scoped to the original authenticated device", async () => {
  const { agentId, authSessionId, intent } = await fixture();
  const input = {
    agentId,
    requestId: intent.id,
    target: intent.target,
    nativeAssistantId: "assistant-test",
    nativeSession: {
      authSessionId,
      deadline: new Date(Date.now() + 60000).toISOString(),
    },
  };
  assert.equal((await reserveDirectVoice(pool, input)).id, intent.id);
  await assert.rejects(
    reserveDirectVoice(pool, {
      ...input,
      nativeSession: { ...input.nativeSession, authSessionId: randomUUID() },
    }),
    { status: 409 },
  );
  await assert.rejects(
    reserveDirectVoice(pool, {
      agentId,
      requestId: intent.id,
      target: intent.target,
    }),
    { status: 409 },
  );
  await updateNativeAssistant(pool, agentId, {
    id: intent.id,
    state: "ended",
    authSessionId,
  });
});
