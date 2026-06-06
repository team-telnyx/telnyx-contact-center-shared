import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

const authSources = [
  "app/actions/auth.js",
  "app/api/auth/[...nextauth]/route.js",
  "app/api/auth/me/route.js",
  "app/api/auth/signin/route.js",
  "app/api/auth/google-signin/route.js",
  "app/api/auth/logout/route.js",
  "app/api/auth/refresh/route.js",
  "app/api/auth/update-password/route.js",
  "app/api/auth/forgot-password/route.js",
  "app/api/auth/reset-password/route.js",
  "app/api/auth/activate/route.js",
  "app/api/auth/invite/[token]/route.js",
];

test("auth flows emit structured pino auth events instead of direct console output", async () => {
  const expectedEvents = new Set([
    "signin_attempt",
    "signin_failed",
    "signin_success",
    "signup_attempt",
    "signup_failed",
    "signup_success",
    "password_reset_requested",
    "password_reset_success",
    "password_change_success",
    "logout_attempt",
    "logout_success",
    "refresh_success",
    "account_activation_success",
    "invite_accept_success",
  ]);

  const combined = [];
  for (const file of authSources) {
    const src = await source(file);
    combined.push(src);
    assert.match(src, /@\/lib\/auth-logging\.mjs/, `${file} should use the shared auth logger`);
    assert.doesNotMatch(src, /console\.(log|warn|error)\(/, `${file} should not log auth through console`);
  }

  const all = combined.join("\n");
  for (const event of expectedEvents) {
    assert.match(all, new RegExp(`\\b${event}\\b`), `missing auth event ${event}`);
  }
});

test("auth logger helper preserves the auth topic and never exposes raw credentials or tokens", async () => {
  const src = await source("lib/auth-logging.mjs");

  assert.match(src, /createDiagnosticLogger\("auth"\)/);
  assert.match(src, /sanitizeDiagnosticPayload/);
  assert.match(src, /\[REDACTED\]/);
  assert.doesNotMatch(src, /password\s*[,}]/, "raw password fields must not be forwarded");
  assert.doesNotMatch(src, /token\s*[,}]/, "raw token fields must not be forwarded");
});

test("auth logger lazily loads runtime logging config before emitting when worker cache is cold", async () => {
  const src = await source("lib/auth-logging.mjs");

  assert.match(src, /getCachedRuntimeLoggingConfig/, "auth logger should check whether this worker already has runtime logging config cached");
  assert.match(src, /tryLoadRuntimeLoggingConfigEarly/, "auth logger should bootstrap runtime config before first auth event in cold Next workers");
  assert.match(src, /ensureRuntimeLoggingConfig/, "auth logger should centralize the lazy runtime-config bootstrap");
  assert.match(src, /return ensureRuntimeLoggingConfig\(\)\.then/, "logAuthEvent should return the bootstrap promise so terminal auth events can await file/console emission");
  assert.match(src, /RUNTIME_CONFIG_BOOTSTRAP_RETRY_MS/, "failed bootstrap attempts should be negative-cached briefly");
  assert.match(src, /runtimeConfigLoadRetryAfterMs/, "auth logger should avoid opening a new bootstrap pool for every auth event when config is unavailable");
});

test("NextAuth credentials keeps non-terminal attempt logging off the sign-in critical path", async () => {
  const src = await source("app/api/auth/[...nextauth]/route.js");

  assert.match(src, /logAuthEvent\("info", "signin_attempt", \{ method: "nextauth_credentials"/);
  assert.doesNotMatch(src, /await logAuthEvent\("info", "signin_attempt"/);
});

test("NextAuth credentials logs failed signin for invalid credentials before returning null", async () => {
  const src = await source("app/api/auth/[...nextauth]/route.js");

  assert.match(src, /reason: "invalid_credentials"/, "bad username/password should produce signin_failed, not only signin_attempt");
  assert.match(src, /await logAuthEvent\("warn", "signin_failed", \{ method: "nextauth_credentials"[\s\S]*reason: "invalid_credentials"[\s\S]*return null;/);
});

test("logout emits a terminal auth event for every successful request, even without a token to revoke", async () => {
  const src = await source("app/api/auth/logout/route.js");

  assert.match(src, /let revokedRefreshToken = false;/);
  assert.match(src, /await logAuthEvent\("info", "logout_success", \{[\s\S]*hasRefreshToken: Boolean\(refreshToRevoke\)[\s\S]*revokedRefreshToken[\s\S]*\}\);/);
  assert.ok(src.indexOf('await logAuthEvent("info", "logout_success"') > src.indexOf('if (userId && refreshToRevoke)'), "logout_success should be emitted after optional revoke flow, not only inside it");
});
