import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createWidgetTestGrant, verifyWidgetTestGrant, createWidgetBootstrapToken } from "../lib/widgets/session-tokens.js";
import { isWidgetOriginAllowed, isWidgetSessionOriginAllowed, isWidgetTestOrigin, widgetTestOrigin } from "../lib/widgets/config.js";
import { parseWidgetTestContext, storedWidgetTestContext, WIDGET_TEST_CONTEXT_KEY, WIDGET_TEST_DEFAULT_CONTEXT } from "../lib/widgets/test-page.js";
import { needsPortalProviders, WIDGET_TEST_HOST_PATH } from "../lib/portal-providers.js";

process.env.WIDGET_SESSION_SIGNING_SECRET = "widget-test-page-test-only-signing-key-at-least-32-characters";
const origin = "https://cc.example.test";

test("a test grant is bound to the widget, the origin and its lifetime", () => {
  const now = 1_700_000_000_000;
  const grant = createWidgetTestGrant({ publicId: "wgt_a", origin, userId: 7, now });
  assert.equal(verifyWidgetTestGrant(grant, { publicId: "wgt_a", origin, now }).sub, "7");
  assert.equal(verifyWidgetTestGrant(grant, { publicId: "wgt_b", origin, now }), null);
  assert.equal(verifyWidgetTestGrant(grant, { publicId: "wgt_a", origin: "https://evil.example", now }), null);
  assert.equal(verifyWidgetTestGrant(grant, { publicId: "wgt_a", origin, now: now + 13 * 3600 * 1000 }), null);
  const [payload, signature] = grant.split(".");
  assert.equal(verifyWidgetTestGrant(`${payload}.${signature.slice(0, -1)}A`, { publicId: "wgt_a", origin, now }), null);
  for (const value of [null, "", "a.b.c", "x"]) assert.equal(verifyWidgetTestGrant(value, { publicId: "wgt_a", origin, now }), null);
});

test("a bootstrap token cannot stand in for a test grant", () => {
  const token = createWidgetBootstrapToken({ publicId: "wgt_a", revisionId: "rev", origin });
  assert.equal(verifyWidgetTestGrant(token, { publicId: "wgt_a", origin }), null);
});

test("only the marked origin passes the session check without the allowlist; a request origin never does", () => {
  assert.equal(isWidgetTestOrigin(widgetTestOrigin(origin)), true);
  assert.equal(isWidgetSessionOriginAllowed(widgetTestOrigin(origin), []), true);
  assert.equal(isWidgetSessionOriginAllowed(origin, []), false);
  assert.equal(isWidgetSessionOriginAllowed(origin, [origin]), true);
  // The bootstrap route checks the request origin with the allowlist function,
  // so a forged "cc-test:" Origin header gains nothing there.
  assert.equal(isWidgetOriginAllowed(widgetTestOrigin(origin), [origin]), false);
});

test("the host context accepts a flat JSON object only", () => {
  assert.deepEqual(parseWidgetTestContext(""), { context: {}, error: null });
  assert.deepEqual(parseWidgetTestContext('{"customer.segment":"vip","n":1,"b":true}').context, { "customer.segment": "vip", n: 1, b: true });
  assert.match(parseWidgetTestContext("{").error, /valid JSON/);
  assert.match(parseWidgetTestContext("[1]").error, /JSON object/);
  assert.match(parseWidgetTestContext('{"a":{"b":1}}').error, /"a"/);
});

test("the sample context is offered until the user stores one, and an emptied context stays empty", () => {
  const storage = (value) => ({ getItem: (key) => (key === WIDGET_TEST_CONTEXT_KEY ? value : null) });
  assert.deepEqual(Object.keys(parseWidgetTestContext(WIDGET_TEST_DEFAULT_CONTEXT).context), ["first_name", "last_name", "company", "phone_number", "email"]);
  assert.equal(storedWidgetTestContext(storage(null)), WIDGET_TEST_DEFAULT_CONTEXT);
  assert.equal(storedWidgetTestContext(storage("")), "");
  assert.equal(storedWidgetTestContext(storage('{"a":1}')), '{"a":1}');
  assert.equal(storedWidgetTestContext({ getItem() { throw new Error("blocked"); } }), WIDGET_TEST_DEFAULT_CONTEXT);
});

test("the stand-in customer page does not boot the portal providers, so it opens no status stream", () => {
  assert.equal(needsPortalProviders(WIDGET_TEST_HOST_PATH), false);
  assert.equal(needsPortalProviders("/widget/frame"), false);
  for (const path of ["/admin/widgets", "/admin/widgets/test-host/", "/", "/supervisor/monitor"]) {
    assert.equal(needsPortalProviders(path), true, path);
  }
  const host = readFileSync(new URL("../app/admin/widgets/test-host/page.jsx", import.meta.url), "utf8");
  assert.equal(/useSession|subscribeStatusStream|EventSource/.test(host), false);
  const provider = readFileSync(new URL("../components/conditional-session-provider.jsx", import.meta.url), "utf8");
  assert.match(provider, /needsPortalProviders\(pathname\)/);
});

test("the loader forwards the grant to every bootstrap call and the public demo page is gone", () => {
  const loader = readFileSync(new URL("../public/widget/v1/loader.js", import.meta.url), "utf8");
  assert.equal(loader.match(/\/bootstrap"/g).length, 1, "bootstrap URL is built in one place");
  assert.equal(loader.match(/fetch\(bootstrapUrl\(/g).length, 3);
  assert.match(loader, /script\.dataset\.testGrant/);
  assert.equal(existsSync(new URL("../public/widget-demo.html", import.meta.url)), false);
});
