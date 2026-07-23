import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";

process.env.TELNYX_API_KEY = "test-key";

let assignPhoneNumberToApp;
let unassignPhoneNumberFromApp;
let originalFetch;

before(async () => {
  originalFetch = global.fetch;
  ({ assignPhoneNumberToApp, unassignPhoneNumberFromApp } = await import(
    "../lib/telnyx-voice-apps.js"
  ));
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockPatch(responseData, capture) {
  global.fetch = async (url, options) => {
    capture.push({ url: String(url), body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: responseData });
      },
    };
  };
}

test("assignPhoneNumberToApp binds through connection_id and verifies the result", async () => {
  const calls = [];
  mockPatch(
    { id: "pn-1", phone_number: "+12025550123", connection_id: "app-1" },
    calls,
  );

  const result = await assignPhoneNumberToApp("pn-1", "app-1");

  assert.deepEqual(calls[0].body, { connection_id: "app-1" });
  assert.equal(result.connection_id, "app-1");
});

test("assignPhoneNumberToApp rejects a silent Telnyx no-op", async () => {
  mockPatch(
    { id: "pn-1", phone_number: "+12025550123", connection_id: null },
    [],
  );

  await assert.rejects(
    () => assignPhoneNumberToApp("pn-1", "app-1"),
    /did not assign the phone number/,
  );
});

test("unassignPhoneNumberFromApp clears connection_id and verifies the result", async () => {
  const calls = [];
  mockPatch(
    { id: "pn-1", phone_number: "+12025550123", connection_id: null },
    calls,
  );

  const result = await unassignPhoneNumberFromApp("pn-1");

  assert.deepEqual(calls[0].body, { connection_id: null });
  assert.equal(result.connection_id, null);
});

test("unassignPhoneNumberFromApp rejects a silent Telnyx no-op", async () => {
  mockPatch(
    { id: "pn-1", phone_number: "+12025550123", connection_id: "app-1" },
    [],
  );

  await assert.rejects(
    () => unassignPhoneNumberFromApp("pn-1"),
    /did not unassign the phone number/,
  );
});

test("unassignPhoneNumberFromApp rejects a response without connection state", async () => {
  mockPatch({ id: "pn-1", phone_number: "+12025550123" }, []);

  await assert.rejects(
    () => unassignPhoneNumberFromApp("pn-1"),
    /did not unassign the phone number/,
  );
});
