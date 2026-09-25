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

test("an expired credential is renewed for this user, never swapped for another", async () => {
  // This test used to require that an expired credential be reported and never
  // retried. The route now renews it and retries once, which is the point of
  // the change — but the concern it was written for is unchanged: the second
  // attempt must use a credential minted for *this* user, not one found by
  // searching, and not an account-wide one.
  const source = await readFile(routePath, "utf8");
  const expiredBranch = source.match(
    /if \(tokenError\.code !== "CREDENTIAL_EXPIRED"[\s\S]*?\n  \} catch \(err\)/,
  )?.[0];

  assert.ok(expiredBranch, "the expiry branch must still be keyed off the error code");
  assert.match(expiredBranch, /renewUserTelephonyCredential\(user, credentialId\)/);
  assert.match(expiredBranch, /createAccessToken\(telnyxApiKey, renewed\.id\)/);
  assert.doesNotMatch(expiredBranch, /fetchCredentialIdByUsername/);
  // One retry only: a credential minted seconds ago that is already expired
  // means something other than age is wrong, and looping would hide it.
  assert.equal((expiredBranch.match(/createAccessToken\(/g) || []).length, 1);
  // A renewal that fails still tells the caller what happened.
  assert.match(expiredBranch, /code: "CREDENTIAL_EXPIRED"/);
});
