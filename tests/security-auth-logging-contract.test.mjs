import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  helper: "lib/security-logging.mjs",
  auth: "lib/auth.js",
  authServer: "lib/auth-server.js",
  recaptcha: "lib/recaptcha.js",
  secrets: "lib/secrets.js",
  telnyxCredentials: "lib/telnyx-credentials.js",
  voiceToken: "app/api/voice/token/route.js",
  authMethods: "app/api/user/auth-methods/route.js",
};

const runtimeFiles = Object.values(files).filter((file) => file !== files.helper);
const legacyDiagnostics = /console\.(log|warn|error|info|debug)|[`"]\[[A-Za-z0-9][^`"]*\]/;
const loggerCall = /(?:authLogger|sessionsLogger|credentialsLogger|adminSecurityLogger)\.(?:debug|info|warn|error)\(([^;]+)\);/gs;

async function source(file) {
  return readFile(file, "utf8");
}

function calls(src) {
  const out = [];
  let match;
  while ((match = loggerCall.exec(src))) out.push(match[1]);
  return out;
}

test("Security logging helper exposes approved topic loggers", async () => {
  const helper = await source(files.helper);
  for (const topic of ["security.auth", "security.sessions", "security.credentials", "security.admin"]) {
    assert.match(helper, new RegExp(`createDiagnosticLogger\\(\\s*["']${topic}["']\\s*\\)`));
  }
  for (const exportName of ["authLogger", "sessionsLogger", "credentialsLogger", "adminSecurityLogger", "securityErrorPayload", "securityUserPayload", "credentialPayload"]) {
    assert.match(helper, new RegExp(`export (?:function|const) ${exportName}\\b`));
  }
});

test("Security/auth runtime files use structured loggers without legacy console diagnostics", async () => {
  for (const file of runtimeFiles) {
    const src = await source(file);
    assert.doesNotMatch(src, legacyDiagnostics, `${file} should not contain console.* or bracket-prefix diagnostics`);
    assert.match(src, /security-logging\.mjs/, `${file} should import security logging helper`);
    assert.match(src, /(?:authLogger|sessionsLogger|credentialsLogger|adminSecurityLogger)\.(?:debug|info|warn|error)\(/, `${file} should emit structured logs`);
  }
});

test("Security/auth logger calls never include secrets, tokens, passwords, or raw responses", async () => {
  const forbidden = /\b(password|plainPassword|token|apiKey|secretKey|SECRET_KEY|raw|responseText|Authorization|headers|credentialResponse)\b/i;
  for (const file of runtimeFiles) {
    const src = await source(file);
    const fileCalls = calls(src);
    assert.ok(fileCalls.length > 0, `${file} should have logger calls`);
    for (const call of fileCalls) {
      assert.doesNotMatch(call, forbidden, `${file} logger call should avoid secret-bearing identifiers: ${call}`);
    }
  }
});
