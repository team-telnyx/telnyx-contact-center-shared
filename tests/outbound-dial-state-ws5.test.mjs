import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Load DB env from .env (node:test does not load Next.js dotenv files).
async function loadEnvFile() {
  try {
    const raw = await readFile(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* no .env — DB-dependent tests will be skipped */
  }
}

await loadEnvFile();

const { getPostgresPool } = await import("../lib/postgres.mjs");

async function dbAvailable() {
  try {
    const pool = getPostgresPool();
    if (!pool) return false;
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const hasDb = await dbAvailable();

const {
  DIAL_STATES,
  ALLOWED_TRANSITIONS,
  TERMINAL_DIAL_STATES,
  isValidTransition,
  dialStateForWebhookEvent,
  nextStateAfterFailure,
  transitionDialState,
} = await import("../lib/outbound-dialer/dial-state.js");

test("WS5-T1 Appendix C happy path is a valid transition chain", () => {
  const happyPath = [
    [DIAL_STATES.PENDING, DIAL_STATES.DIALING],
    [DIAL_STATES.DIALING, DIAL_STATES.RINGING],
    [DIAL_STATES.RINGING, DIAL_STATES.HUMAN],
    [DIAL_STATES.HUMAN, DIAL_STATES.CONNECTING],
    [DIAL_STATES.CONNECTING, DIAL_STATES.CONNECTED],
    [DIAL_STATES.CONNECTED, DIAL_STATES.WRAPUP],
    [DIAL_STATES.WRAPUP, DIAL_STATES.DISPOSED],
  ];
  for (const [from, to] of happyPath) {
    assert.equal(isValidTransition(from, to), true, `${from} → ${to} must be allowed`);
  }
});

test("WS5-T1 invalid jumps are rejected", () => {
  assert.equal(isValidTransition(DIAL_STATES.PENDING, DIAL_STATES.CONNECTED), false);
  assert.equal(isValidTransition(DIAL_STATES.DISPOSED, DIAL_STATES.DIALING), false);
  assert.equal(isValidTransition(DIAL_STATES.MACHINE, DIAL_STATES.CONNECTING), false, "machine must not reach an agent");
  assert.equal(isValidTransition(DIAL_STATES.WRAPUP, DIAL_STATES.CONNECTED), false, "no going back from wrapup");
});

test("WS5-T1 machine/abandon/retry branches from Appendix C", () => {
  assert.equal(isValidTransition(DIAL_STATES.MACHINE, DIAL_STATES.VOICEMAIL_ACTION), true);
  assert.equal(isValidTransition(DIAL_STATES.VOICEMAIL_ACTION, DIAL_STATES.DISPOSED), true);
  assert.equal(isValidTransition(DIAL_STATES.HUMAN, DIAL_STATES.ABANDONED), true, "over-dial with no agent");
  assert.equal(isValidTransition(DIAL_STATES.NO_ANSWER, DIAL_STATES.RETRY), true);
  assert.equal(isValidTransition(DIAL_STATES.BUSY, DIAL_STATES.EXHAUSTED), true);
  assert.equal(isValidTransition(DIAL_STATES.RETRY, DIAL_STATES.DIALING), true, "retry re-enters dialing");
  for (const state of TERMINAL_DIAL_STATES) {
    for (const target of Object.keys(ALLOWED_TRANSITIONS)) {
      assert.equal(
        isValidTransition(state, target),
        false,
        `terminal ${state} must have no outgoing transition (${target})`,
      );
    }
  }
});

test("WS5-T1 webhook events map to expected dial states", () => {
  assert.equal(dialStateForWebhookEvent("call.initiated"), DIAL_STATES.DIALING);
  assert.equal(dialStateForWebhookEvent("call.ringing"), DIAL_STATES.RINGING);
  assert.equal(dialStateForWebhookEvent("call.answered"), DIAL_STATES.HUMAN);
  assert.equal(
    dialStateForWebhookEvent("call.machine.detection.ended", { amdResult: "machine" }),
    DIAL_STATES.MACHINE,
  );
  assert.equal(
    dialStateForWebhookEvent("call.machine.detection.ended", { amdResult: "human" }),
    DIAL_STATES.HUMAN,
  );
  assert.equal(dialStateForWebhookEvent("call.machine.greeting.ended"), DIAL_STATES.MACHINE);
  assert.equal(dialStateForWebhookEvent("call.machine.premium.greeting.ended"), DIAL_STATES.MACHINE);
  assert.equal(
    dialStateForWebhookEvent("call.hangup", { hangupCause: "user_busy" }),
    DIAL_STATES.BUSY,
  );
  assert.equal(
    dialStateForWebhookEvent("call.hangup", { hangupCause: "no_answer" }),
    DIAL_STATES.NO_ANSWER,
  );
  assert.equal(
    dialStateForWebhookEvent("call.hangup", { wasConnected: true, hangupCause: "normal_clearing" }),
    DIAL_STATES.WRAPUP,
  );
  assert.equal(dialStateForWebhookEvent("call.playback.started"), null);
});

test("WS5-T1 retry/exhausted decision", () => {
  assert.equal(
    nextStateAfterFailure({ attemptCount: 1, maxAttempts: 3, retryEligible: true }),
    DIAL_STATES.RETRY,
  );
  assert.equal(
    nextStateAfterFailure({ attemptCount: 3, maxAttempts: 3, retryEligible: true }),
    DIAL_STATES.EXHAUSTED,
  );
  assert.equal(
    nextStateAfterFailure({ attemptCount: 0, maxAttempts: 3, retryEligible: false }),
    DIAL_STATES.EXHAUSTED,
  );
});

test("WS5-T1 execution.js wires dial-state additively (legacy status flow untouched)", async () => {
  const source = await readFile(
    new URL("../lib/outbound-dialer/execution.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/dial-state\.js"/, "execution imports the state machine");
  assert.match(
    source,
    /applyDialStateForEvent\(pool, ledgerRow, "call\.initiated"/,
    "originate marks dialing",
  );
  assert.match(
    source,
    /applyDialStateForEvent\(pool, ledger, "call\.answered"/,
    "answered marks human",
  );
  assert.match(
    source,
    /applyDialStateForEvent\(pool, ledger, "call\.hangup"/,
    "hangup maps to busy/no_answer/failed/wrapup",
  );
  // Legacy coarse status writes must still be present and unchanged.
  assert.match(source, /SET status = 'answered'/, "legacy answered write intact");
  assert.match(source, /markAttemptStatus\(pool, ledgerRow\.id, "dialing"/, "legacy dialing write intact");
});

test(
  "WS5-T1 CAS transition: applies once, rejects stale/invalid, records history",
  { skip: !hasDb && "postgres not reachable" },
  async () => {
    const pool = getPostgresPool();
    // Create a scratch campaign + ledger row.
    const { rows: campaignRows } = await pool.query(
      `INSERT INTO outbound_campaigns (name, status, mode)
       VALUES ($1, 'draft', 'power')
       RETURNING id`,
      [`ws5-test-${randomUUID()}`],
    );
    const campaignId = campaignRows[0].id;
    const { rows: ledgerRows } = await pool.query(
      `INSERT INTO outbound_attempt_ledger (campaign_id, status)
       VALUES ($1, 'claimed')
       RETURNING id, dial_state`,
      [campaignId],
    );
    const ledgerId = ledgerRows[0].id;
    assert.equal(ledgerRows[0].dial_state, "pending", "new rows default to pending");

    try {
      // pending → dialing applies.
      const first = await transitionDialState(pool, ledgerId, DIAL_STATES.DIALING, { event: "call.initiated" });
      assert.equal(first.applied, true);
      assert.equal(first.row.dial_state, "dialing");

      // Replay of the same transition is a no-op (CAS source no longer matches).
      const replay = await transitionDialState(pool, ledgerId, DIAL_STATES.DIALING, { event: "call.initiated" });
      assert.equal(replay.applied, false, "replayed transition must not re-apply");

      // dialing → connected (invalid jump) rejected.
      const invalid = await transitionDialState(pool, ledgerId, DIAL_STATES.CONNECTED, {});
      assert.equal(invalid.applied, false);

      // dialing → ringing → human applies; history accumulates.
      await transitionDialState(pool, ledgerId, DIAL_STATES.RINGING, { event: "call.ringing" });
      const human = await transitionDialState(pool, ledgerId, DIAL_STATES.HUMAN, { event: "call.answered" });
      assert.equal(human.applied, true);
      const history = human.row.metadata?.dial_state_history;
      assert.ok(Array.isArray(history) && history.length === 3, "history records each applied transition");
      assert.deepEqual(
        history.map((h) => h.to),
        ["dialing", "ringing", "human"],
      );

      // Concurrency: parallel attempts at the same transition — exactly one wins.
      const raceResults = await Promise.all(
        Array.from({ length: 8 }, () =>
          transitionDialState(pool, ledgerId, DIAL_STATES.CONNECTING, { event: "race" }),
        ),
      );
      assert.equal(
        raceResults.filter((r) => r.applied).length,
        1,
        "exactly one concurrent transition may apply",
      );
    } finally {
      await pool.query("DELETE FROM outbound_attempt_ledger WHERE id = $1", [ledgerId]);
      await pool.query("DELETE FROM outbound_campaigns WHERE id = $1", [campaignId]);
    }
  },
);
