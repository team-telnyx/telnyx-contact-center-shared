// Regression tests for lib/seed-default-owner.mjs's Telnyx voice_number wiring
// (bug #3 from the 2026-07-05 wizard log: the owner account was created in
// Telnyx by the deploy wizard's bootstrap step, but the `users` row never
// learned the assigned voice number), plus the owner's full-role-set and
// "Sales" queue assignment (added 2026-07-09 after a GCP wizard E2E test
// showed a freshly seeded owner had no access to the Contact Center agent
// desktop — only the `owner` role was ever seeded, not agent/supervisor/
// admin, and the owner was never assigned into the seeded queue).
//
// NOTE: telephony_credentials_id/telephony_user_name are deliberately NOT
// seeded here (and never read from env) — NextAuth's own
// auto-create-credentials-on-first-login path (see
// app/api/auth/[...nextauth]/route.js) creates the owner's telephony
// credential lazily on first login, exactly like it does for every other
// user. Pre-seeding it here was pure duplication of that idempotent
// app-side mechanism (confirmed via real E2E testing) and left an extra,
// unused Telnyx credential behind on every wizard re-run. These tests
// assert those columns stay untouched (null on create, unchanged on
// backfill) and that only voice_number gets synced from
// TELNYX_MAIN_FROM_NUMBER.
//
// These tests use a mock `pg`-shaped Pool (no real Postgres needed) injected
// via lib/postgres.mjs's own `global.__pg_pool` cache slot (getPostgresPool()
// returns `cached.pool` immediately if already set — see lib/postgres.mjs),
// which avoids needing ESM module-mocking flags/APIs not used elsewhere in
// this test suite.
import { test } from "node:test";
import assert from "node:assert/strict";

const ALL_ROLES = ["agent", "supervisor", "admin", "owner"];

function makeMockPool(initialUsers = [], initialQueueAssignments = []) {
  const state = {
    users: initialUsers.map((u) => ({ ...u })),
    queueAssignments: initialQueueAssignments.map((a) => ({ ...a })),
  };
  const pool = {
    async connect() {
      return {
        async query(text, params = []) {
          const sql = text.trim();
          if (sql.startsWith("SET statement_timeout") || sql.startsWith("RESET statement_timeout")) {
            return { rows: [] };
          }
          if (sql.startsWith("SELECT id, username, roles, verified, telephony_credentials_id")) {
            const [username] = params;
            const found = state.users.find((u) => u.username === username);
            return { rows: found ? [found] : [] };
          }
          if (sql.startsWith("SELECT id FROM domains")) {
            return { rows: [] }; // domain check is a soft warning only, absence is fine
          }
          if (sql.startsWith("INSERT INTO users")) {
            const [
              id, username, email, first_name, last_name, nick,
              roles, verified, auth_strategy, hash, salt, iterations,
              available_for_routing, active,
              telephony_credentials_id, telephony_user_name, voice_number,
            ] = params;
            state.users.push({
              id, username, email, first_name, last_name, nick,
              roles, verified, auth_strategy, hash, salt, iterations,
              available_for_routing, active,
              telephony_credentials_id, telephony_user_name, voice_number,
            });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE users SET")) {
            // Last param is always the id (WHERE id = $N).
            const id = params[params.length - 1];
            const user = state.users.find((u) => u.id === id);
            assert.ok(user, `UPDATE targeted unknown user id ${id}`);
            if (sql.includes("roles = $1")) user.roles = params[0];
            if (sql.includes("verified = true")) user.verified = true;
            // Walk remaining SET clauses in declared order to figure out
            // which telephony column each trailing param maps to — mirrors
            // how the real query is built (column list order == param order).
            // Only voice_number is ever a dynamic SET clause now (see
            // seed-default-owner.mjs's telephonyFields array).
            const colOrder = [];
            if (sql.includes("voice_number = $")) colOrder.push("voice_number");
            const roleParamCount = sql.includes("roles = $1") ? 1 : 0;
            const telephonyParams = params.slice(roleParamCount, params.length - 1);
            colOrder.forEach((col, i) => { user[col] = telephonyParams[i]; });
            return { rows: [] };
          }
          if (sql.startsWith("INSERT INTO cc_queue_user_assignments")) {
            const [queue_id, user_id] = params;
            const exists = state.queueAssignments.find(
              (a) => a.queue_id === queue_id && a.user_id === user_id
            );
            if (!exists) {
              state.queueAssignments.push({
                queue_id, user_id, enabled: true, activated_at: "now",
              });
            }
            return { rows: [] };
          }
          throw new Error(`Unmocked query: ${sql}`);
        },
        release() {},
      };
    },
  };
  return { pool, state };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

// Injects a mock pool via lib/postgres.mjs's module-level cache slot
// (global.__pg_pool.pool). IMPORTANT: postgres.mjs binds its internal
// `cached` variable to whatever object sits at global.__pg_pool at
// *first import* (`let cached = global.__pg_pool`), and that binding is
// permanent for the life of the process (ES modules are cached per URL,
// so postgres.mjs only ever runs its top-level code once here). That means
// REPLACING global.__pg_pool with a brand-new object in later tests has NO
// effect on what getPostgresPool() actually returns — it still reads the
// original object's `.pool` field. We must force that first-import binding
// to happen, then MUTATE the existing object's fields in place (and restore
// them afterwards) rather than reassigning global.__pg_pool wholesale.
async function withMockPool(pool, fn) {
  // Force postgres.mjs to load (and bind `cached`) before we touch anything.
  await import("../lib/postgres.mjs");
  const cached = global.__pg_pool;
  assert.ok(cached, "expected postgres.mjs to have initialized global.__pg_pool on import");
  const prev = { pool: cached.pool, status: cached.status, listenersAttached: cached.listenersAttached };
  cached.pool = pool;
  cached.status = "connected";
  cached.listenersAttached = true;
  try {
    await fn();
  } finally {
    cached.pool = prev.pool;
    cached.status = prev.status;
    cached.listenersAttached = prev.listenersAttached;
  }
}

test("seedDefaultOwner: creates a new owner row with voice_number populated, telephony credential fields left null for NextAuth to fill lazily", async () => {
  const { pool, state } = makeMockPool([]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
        TELNYX_MAIN_FROM_NUMBER: "+141****0100",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        assert.equal(state.users.length, 1);
        const owner = state.users[0];
        assert.equal(owner.telephony_credentials_id, null);
        assert.equal(owner.telephony_user_name, null);
        assert.equal(owner.voice_number, "+141****0100");
      }
    )
  );
});

test("seedDefaultOwner: backfills voice_number onto an existing owner row missing it, without touching telephony credential fields", async () => {
  const { pool, state } = makeMockPool([
    {
      id: "u1",
      username: "owner@example.com",
      roles: ALL_ROLES,
      verified: true,
      telephony_credentials_id: null,
      telephony_user_name: null,
      voice_number: null,
    },
  ]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
        TELNYX_MAIN_FROM_NUMBER: "+141****0199",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        const owner = state.users.find((u) => u.id === "u1");
        assert.equal(owner.telephony_credentials_id, null);
        assert.equal(owner.telephony_user_name, null);
        assert.equal(owner.voice_number, "+141****0199");
      }
    )
  );
});

test("seedDefaultOwner: does NOT overwrite voice_number already set on an existing owner row", async () => {
  const { pool, state } = makeMockPool([
    {
      id: "u1",
      username: "owner@example.com",
      roles: ALL_ROLES,
      verified: true,
      telephony_credentials_id: "already-set",
      telephony_user_name: "already-set-user",
      voice_number: "+100****0000",
    },
  ]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
        TELNYX_MAIN_FROM_NUMBER: "+199****9999",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        const owner = state.users.find((u) => u.id === "u1");
        assert.equal(owner.telephony_credentials_id, "already-set");
        assert.equal(owner.telephony_user_name, "already-set-user");
        assert.equal(owner.voice_number, "+100****0000");
      }
    )
  );
});

test("seedDefaultOwner: promotes an existing non-owner user to owner (and every other role) and still backfills voice_number", async () => {
  const { pool, state } = makeMockPool([
    {
      id: "u1",
      username: "owner@example.com",
      roles: ["agent"],
      verified: false,
      telephony_credentials_id: null,
      telephony_user_name: null,
      voice_number: null,
    },
  ]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
        TELNYX_MAIN_FROM_NUMBER: "+141****0188",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        const owner = state.users.find((u) => u.id === "u1");
        assert.ok(owner.roles.includes("owner"));
        // Regression: previously only "owner" was ever added — now every
        // standard role must be merged in, and the pre-existing "agent"
        // role must survive (not be dropped/replaced).
        assert.ok(owner.roles.includes("agent"));
        assert.ok(owner.roles.includes("supervisor"));
        assert.ok(owner.roles.includes("admin"));
        assert.equal(owner.verified, true);
        assert.equal(owner.telephony_credentials_id, null);
        assert.equal(owner.telephony_user_name, null);
        assert.equal(owner.voice_number, "+141****0188");
      }
    )
  );
});

test("seedDefaultOwner: a brand-new owner gets all four roles (agent, supervisor, admin, owner) and is routable", async () => {
  const { pool, state } = makeMockPool([]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        const owner = state.users[0];
        assert.deepEqual([...owner.roles].sort(), [...ALL_ROLES].sort());
        // Regression: previously hardcoded false ("owner typically doesn't
        // take calls") — now true so the owner can actually receive calls
        // routed to the seeded "Sales" queue it's assigned into below.
        assert.equal(owner.available_for_routing, true);
      }
    )
  );
});

test("seedDefaultOwner: assigns a brand-new owner into the seeded Sales queue (enabled + activated)", async () => {
  const { SEEDED_DEFAULT_QUEUE_ID } = await import("../lib/seed-default-queue.mjs");
  const { pool, state } = makeMockPool([]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        const owner = state.users[0];
        assert.equal(state.queueAssignments.length, 1);
        const assignment = state.queueAssignments[0];
        assert.equal(assignment.queue_id, SEEDED_DEFAULT_QUEUE_ID);
        assert.equal(assignment.user_id, owner.id);
        assert.equal(assignment.enabled, true);
        assert.ok(assignment.activated_at);
      }
    )
  );
});

test("seedDefaultOwner: assigns an EXISTING owner (already fully-roled) into the Sales queue if not already assigned", async () => {
  const { SEEDED_DEFAULT_QUEUE_ID } = await import("../lib/seed-default-queue.mjs");
  const { pool, state } = makeMockPool([
    {
      id: "u1",
      username: "owner@example.com",
      roles: ALL_ROLES,
      verified: true,
      telephony_credentials_id: null,
      telephony_user_name: null,
      voice_number: null,
    },
  ]);
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        assert.equal(state.queueAssignments.length, 1);
        assert.equal(state.queueAssignments[0].queue_id, SEEDED_DEFAULT_QUEUE_ID);
        assert.equal(state.queueAssignments[0].user_id, "u1");
      }
    )
  );
});

test("seedDefaultOwner: is idempotent — re-running does not create a duplicate Sales queue assignment", async () => {
  const { SEEDED_DEFAULT_QUEUE_ID } = await import("../lib/seed-default-queue.mjs");
  const { pool, state } = makeMockPool(
    [
      {
        id: "u1",
        username: "owner@example.com",
        roles: ALL_ROLES,
        verified: true,
        telephony_credentials_id: null,
        telephony_user_name: null,
        voice_number: null,
      },
    ],
    [{ queue_id: SEEDED_DEFAULT_QUEUE_ID, user_id: "u1", enabled: true, activated_at: "earlier" }]
  );
  await withMockPool(pool, () =>
    withEnv(
      {
        DEFAULT_OWNER_EMAIL: "owner@example.com",
        DEFAULT_OWNER_PASSWORD: "supersecret123",
      },
      async () => {
        const { seedDefaultOwner } = await import("../lib/seed-default-owner.mjs");
        const ok = await seedDefaultOwner();
        assert.equal(ok, true);
        assert.equal(state.queueAssignments.length, 1);
        // ON CONFLICT DO NOTHING must not overwrite an operator's later
        // change to this row (e.g. if they'd since deactivated it by hand —
        // activated_at should remain whatever it already was).
        assert.equal(state.queueAssignments[0].activated_at, "earlier");
      }
    )
  );
});
