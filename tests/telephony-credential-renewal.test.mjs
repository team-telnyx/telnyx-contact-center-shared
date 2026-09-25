import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { PgDb } from "../lib/pgdb.js";
import { renewUserTelephonyCredential } from "../lib/telnyx-credentials.js";

// Telnyx credentials created without `expires_at` never expire, but the older
// ones on this account carry a four-hour life and every one of them is now
// dead. Nothing renewed them: a credential was minted at sign-in only when a
// user had none at all, so an expired one stayed expired and the agent's
// softphone simply stopped working — on the web portal as well as on mobile.

const USER = { id: "user-1", username: "agent@telnyx.com", first_name: "A", last_name: "B" };

const routeSource = await readFile(new URL("../app/api/voice/token/route.js", import.meta.url), "utf8");

/**
 * Runs `body` with Telnyx and the users table replaced by recorders.
 * Returns every call both of them saw, in the order they happened, so a test
 * can assert on sequence and not just on totals.
 */
async function withStubs({ createStatus = 200, deleteOk = true, newId = "cred-new" }, body) {
  const originalFetch = global.fetch;
  const originalUpdate = PgDb.updateUserById;
  const env = { ...process.env };
  const calls = [];

  process.env.TELNYX_API_KEY = "KEY_TEST";
  process.env.TELNYX_SIP_CONNECTION_ID = "conn-test";
  process.env.APP_ENV = "development";

  global.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ kind: "telnyx", method, url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (method === "DELETE") return { ok: deleteOk, status: deleteOk ? 200 : 500, text: async () => "" };
    return {
      ok: createStatus < 400,
      status: createStatus,
      text: async () =>
        JSON.stringify(
          createStatus < 400
            ? { data: { id: newId, user: "generated_sip_user", name: "A B", connection_id: "conn-test" } }
            : { errors: [{ detail: "Telnyx said no" }] },
        ),
    };
  };
  PgDb.updateUserById = async (id, set) => {
    calls.push({ kind: "db", id, set });
    return { id };
  };

  try {
    return { result: await body(calls), calls };
  } finally {
    global.fetch = originalFetch;
    PgDb.updateUserById = originalUpdate;
    process.env = env;
  }
}

describe("telephony credential renewal", () => {
  it("mints a credential, records it, and only then removes the dead one", async () => {
    const { result, calls } = await withStubs({}, () => renewUserTelephonyCredential(USER, "cred-old"));

    assert.deepStrictEqual(result, { id: "cred-new", username: "generated_sip_user" });
    assert.deepStrictEqual(
      calls.map((call) => call.kind + ":" + (call.method || "update")),
      ["telnyx:POST", "db:update", "telnyx:DELETE"],
      "deleting before the row is updated would leave the user pointing at nothing",
    );
    assert.deepStrictEqual(calls[1].set, {
      telephonyCredentialsId: "cred-new",
      telephonyUserName: "generated_sip_user",
    });
    assert.match(calls[2].url, /cred-old$/, "the credential removed must be the expired one, not the new one");
  });

  it("keeps the environment tag the sign-in path uses", async () => {
    // Credentials are grouped by tag on the Telnyx side; a renewal that dropped
    // it would quietly split one agent's identity across two groups.
    const { calls } = await withStubs({}, () => renewUserTelephonyCredential(USER));
    assert.strictEqual(calls[0].body.tag, "demo-portal-development");
    assert.strictEqual(calls[0].body.connection_id, "conn-test");
  });

  it("provisions without deleting anything when the user had no credential", async () => {
    const { result, calls } = await withStubs({}, () => renewUserTelephonyCredential(USER));
    assert.strictEqual(result.id, "cred-new");
    assert.ok(!calls.some((call) => call.method === "DELETE"), "there is nothing to clean up");
  });

  it("issues one credential when two requests race", async () => {
    // The normal case, not an edge case: a page and its softphone both ask at
    // once. Two mints would leave the loser's orphaned on the connection
    // forever — which is how the dev connection accumulated 250 of them.
    const { result, calls } = await withStubs({}, () =>
      Promise.all([
        renewUserTelephonyCredential(USER, "cred-old"),
        renewUserTelephonyCredential(USER, "cred-old"),
      ]),
    );

    assert.strictEqual(calls.filter((call) => call.method === "POST").length, 1);
    assert.deepStrictEqual(result[0], result[1], "both callers must be handed the same credential");
  });

  it("returns the new credential even when the old one cannot be deleted", async () => {
    // A credential that will not delete is litter, not a failure: the agent
    // already has a working one.
    const { result, calls } = await withStubs({ deleteOk: false }, () =>
      renewUserTelephonyCredential(USER, "cred-old"),
    );
    assert.strictEqual(result.id, "cred-new");
    assert.ok(calls.some((call) => call.method === "DELETE"));
  });

  it("does not wedge the user after a failed renewal", async () => {
    // If the in-flight entry survived a throw, every later attempt would be
    // handed the same rejected promise and voice would stay dead until restart.
    await withStubs({ createStatus: 422 }, async () => {
      await assert.rejects(() => renewUserTelephonyCredential(USER, "cred-old"), /Telnyx said no/);
    });

    const { result } = await withStubs({ newId: "cred-after-failure" }, () =>
      renewUserTelephonyCredential(USER, "cred-old"),
    );
    assert.strictEqual(result.id, "cred-after-failure");
  });

  it("refuses to renew for a user it cannot identify", async () => {
    const { result, calls } = await withStubs({}, () => renewUserTelephonyCredential({ username: "x" }));
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0, "no row to record it on means no credential should be created");
  });
});

describe("the voice token route", () => {
  // The route is wrapped in `withPermission` and needs a request context, so
  // its contract is pinned here rather than invoked.
  it("renews an expired credential instead of reporting it to the agent", () => {
    assert.match(routeSource, /renewUserTelephonyCredential\(user, credentialId\)/);
    assert.match(
      routeSource.slice(routeSource.indexOf('tokenError.code !== "CREDENTIAL_EXPIRED"')),
      /createAccessToken\(telnyxApiKey, renewed\.id\)/,
      "after renewing, the token must be minted from the new credential",
    );
  });

  it("retries exactly once, so a second expiry is not hidden by a loop", () => {
    const legacyBranch = routeSource.slice(routeSource.indexOf('// Support both snake_case'));
    assert.strictEqual((legacyBranch.match(/await createAccessToken\(/g) || []).length, 2);
  });

  it("reports a failed renewal as an expired credential, not as a server fault", () => {
    // Otherwise the agent sees a 500 carrying the renewal's own message and
    // nothing says which of the two steps actually broke.
    const branch = routeSource.slice(routeSource.indexOf('tokenError.code !== "CREDENTIAL_EXPIRED"'));
    assert.match(branch, /try \{\s*\n\s*renewed = await renewUserTelephonyCredential/);
    assert.match(branch, /catch \(renewError\)/);
  });

  it("provisions for a user with no credential rather than sending them to an administrator", () => {
    assert.match(routeSource, /renewUserTelephonyCredential\(user\)/);
    assert.doesNotMatch(routeSource, /contact your administrator to renew/i);
  });
});
