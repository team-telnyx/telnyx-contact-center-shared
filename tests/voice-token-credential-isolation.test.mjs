import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const routePath = new URL("../app/api/voice/token/route.js", import.meta.url);

test("voice token route never falls back to an account-wide credential", async () => {
  const source = await readFile(routePath, "utf8");

  assert.doesNotMatch(source, /fetchFirstCredentialId/);
  assert.doesNotMatch(source, /TELNYX_TELEPHONY_CREDENTIAL_ID/);
  assert.doesNotMatch(source, /telephony_alternative_credential/);
  assert.doesNotMatch(
    source,
    /user\.telephonyUserName\s*\|\|\s*user\.username|user\.username\s*\|\|\s*user\.email/,
  );
});

test("username recovery requires one exact SIP identity match", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /credentialUsernames\.includes\(expectedUsername\)/);
  assert.match(source, /matches\.length !== 1/);
  assert.match(source, /process\.env\.TELNYX_SIP_CONNECTION_ID/);
});

test("expired credential returns an error without switching identities", async () => {
  const source = await readFile(routePath, "utf8");
  const expiredBranch = source.match(
    /if \(tokenError\.code === "CREDENTIAL_EXPIRED"[\s\S]*?throw tokenError;/,
  )?.[0];

  assert.ok(expiredBranch);
  assert.match(expiredBranch, /code: "CREDENTIAL_EXPIRED"/);
  assert.doesNotMatch(expiredBranch, /createAccessToken\([\s\S]*createAccessToken\(/);
});
