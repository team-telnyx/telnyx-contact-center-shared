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
});
