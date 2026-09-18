import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeTrackedAuthSession,
  openTrackedAuthSession,
} from "../lib/auth-session-tracking.mjs";

function fakePool() {
  const state = {
    users: [{ id: "user-1", username: "agent@example.com" }],
    sessions: [],
    activities: [],
  };

  const query = async (sql, values = []) => {
    if (/FROM users/.test(sql)) {
      const [userId, email] = values;
      const user = state.users.find(
        (entry) =>
          (userId && entry.id === String(userId)) ||
          (email && entry.username.toLowerCase() === String(email).toLowerCase()),
      );
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }
    if (/INSERT INTO cc_user_sessions/.test(sql)) {
      const [id, userId, sessionToken, loginAt] = values;
      if (state.sessions.some((entry) => entry.session_token === sessionToken)) {
        return { rows: [], rowCount: 0 };
      }
      state.sessions.push({
        id,
        user_id: userId,
        session_token: sessionToken,
        login_at: loginAt,
        logout_at: null,
        duration_seconds: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/INSERT INTO cc_user_activity_log/.test(sql)) {
      state.activities.push({
        type: /'logout'/.test(sql) ? "logout" : "login",
        values,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id, login_at, session_token/.test(sql)) {
      const [userId, sessionToken] = values;
      const candidates = state.sessions
        .filter(
          (entry) =>
            entry.user_id === userId &&
            entry.logout_at == null &&
            (!sessionToken || entry.session_token === sessionToken),
        )
        .sort((a, b) => {
          const aExact = sessionToken && a.session_token === sessionToken ? 0 : 1;
          const bExact = sessionToken && b.session_token === sessionToken ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return new Date(b.login_at) - new Date(a.login_at);
        });
      return {
        rows: candidates.length ? [candidates[0]] : [],
        rowCount: candidates.length ? 1 : 0,
      };
    }
    if (/UPDATE cc_user_sessions/.test(sql)) {
      const [id, logoutAt, durationSeconds] = values;
      const session = state.sessions.find(
        (entry) => entry.id === id && entry.logout_at == null,
      );
      if (!session) return { rows: [], rowCount: 0 };
      session.logout_at = logoutAt;
      session.duration_seconds = durationSeconds;
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL in fake pool: ${sql}`);
  };

  return {
    state,
    query,
    async connect() {
      return { query, release() {} };
    },
  };
}

test("NextAuth tracking opens and closes one exact session idempotently", async () => {
  const pool = fakePool();
  const loginAt = "2026-08-02T10:00:00.000Z";
  const logoutAt = "2026-08-02T10:01:30.000Z";

  const opened = await openTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "tracking-token-a",
      loginAt,
    },
    { pool, updateCompatibilityAggregate: false },
  );
  assert.equal(opened.opened, true);

  const duplicate = await openTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "tracking-token-a",
      loginAt,
    },
    { pool, updateCompatibilityAggregate: false },
  );
  assert.equal(duplicate.opened, false);
  assert.equal(pool.state.sessions.length, 1);
  assert.equal(pool.state.activities.filter((row) => row.type === "login").length, 1);

  const closed = await closeTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "tracking-token-a",
      logoutAt,
    },
    { pool, updateCompatibilityAggregate: false },
  );
  assert.equal(closed.closed, true);
  assert.equal(closed.durationSeconds, 90);

  const duplicateClose = await closeTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "tracking-token-a",
      logoutAt,
    },
    { pool, updateCompatibilityAggregate: false },
  );
  assert.equal(duplicateClose.closed, false);
  assert.equal(pool.state.activities.filter((row) => row.type === "logout").length, 1);
});

test("logout closes the correlated NextAuth session, not another open device", async () => {
  const pool = fakePool();
  await openTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "device-a",
      loginAt: "2026-08-02T10:00:00.000Z",
    },
    { pool, updateCompatibilityAggregate: false },
  );
  await openTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "device-b",
      loginAt: "2026-08-02T10:05:00.000Z",
    },
    { pool, updateCompatibilityAggregate: false },
  );

  await closeTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "device-a",
      logoutAt: "2026-08-02T10:10:00.000Z",
    },
    { pool, updateCompatibilityAggregate: false },
  );

  assert.ok(pool.state.sessions.find((row) => row.session_token === "device-a").logout_at);
  assert.equal(
    pool.state.sessions.find((row) => row.session_token === "device-b").logout_at,
    null,
  );

  const duplicateDeviceLogout = await closeTrackedAuthSession(
    {
      userId: "user-1",
      sessionToken: "device-a",
      logoutAt: "2026-08-02T10:11:00.000Z",
    },
    { pool, updateCompatibilityAggregate: false },
  );
  assert.equal(duplicateDeviceLogout.closed, false);
  assert.equal(
    pool.state.sessions.find((row) => row.session_token === "device-b").logout_at,
    null,
  );
});
