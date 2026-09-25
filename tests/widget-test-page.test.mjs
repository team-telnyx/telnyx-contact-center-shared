import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createWidgetTestGrant, verifyWidgetTestGrant, createWidgetBootstrapToken, verifyWidgetBootstrapToken } from "../lib/widgets/session-tokens.js";
import { createDefaultWidgetConfig, isWidgetOriginAllowed, isWidgetSessionOriginAllowed, isWidgetTestOrigin, widgetTestOrigin } from "../lib/widgets/config.js";
import { buildWidgetBootstrapPayload } from "../lib/widgets/bootstrap-payload.js";
import { widgetIconSvgMarkup } from "../lib/widgets/icon-svg.js";
import { WIDGET_ICON_COMPONENTS } from "../lib/widgets/icon-components.js";
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

test("published widget bootstrap renders every launcher icon with the installed icon library", () => {
  const config = createDefaultWidgetConfig("en-US");
  config.cobrowse.enabled = true;
  const record = { public_id: "wgt_a", revision_id: "123e4567-e89b-42d3-a456-426614174000",
    name: "Customer service", version: 24, config };
  const result = buildWidgetBootstrapPayload(record, { publicId: "wgt_a", origin, testGrant: true });
  assert.equal(result.widget.config.cobrowse.enabled, true);
  assert.match(result.widget.launcherIconSvg, /^<svg\b/);
  assert.match(result.widget.launcherIconSvg, /<path\b/);
  assert.equal(verifyWidgetBootstrapToken(result.widget.bootstrapToken, { publicId: "wgt_a" }).org, widgetTestOrigin(origin));
  for (const icon of Object.keys(WIDGET_ICON_COMPONENTS)) {
    assert.match(widgetIconSvgMarkup(icon), /^<svg\b/, icon);
  }
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
  for (const path of ["/admin/widgets/test-host/products", "/admin/widgets/test-host/checkout", "/admin/widgets/test-host/support", "/admin/widgets/test-host/account", "/admin/widgets/test-host/frame"])
    assert.equal(needsPortalProviders(path), false, path);
  assert.equal(needsPortalProviders("/widget/frame"), false);
  for (const path of ["/admin/widgets", "/admin/widgets/test-hostile", "/", "/supervisor/monitor"]) {
    assert.equal(needsPortalProviders(path), true, path);
  }
  const host = readFileSync(new URL("../components/widget-admin/WidgetTestHostPage.jsx", import.meta.url), "utf8");
  assert.equal(/useSession|subscribeStatusStream|EventSource/.test(host), false);
  const provider = readFileSync(new URL("../components/conditional-session-provider.jsx", import.meta.url), "utf8");
  assert.match(provider, /needsPortalProviders\(pathname\)/);
});

test("the co-browsing test host includes safe multi-page privacy and navigation fixtures", () => {
  const host = readFileSync(new URL("../components/widget-admin/WidgetTestHostPage.jsx", import.meta.url), "utf8");
  for (const path of ["overview", "products", "checkout", "support", "account"])
    assert.match(host, new RegExp(`id: "${path}"`), path);
  for (const fixture of ["data-cobrowse-mask", "data-cobrowse-block", "demo-secret-text", "demo-private-panel", "type=\"password\"", "autoComplete=\"cc-number\"", "type=\"file\"", "attachShadow", "iframe", "pushState", "popstate"])
    assert.ok(host.includes(fixture), fixture);
  assert.match(host, /event\.preventDefault\(\)/, "checkout remains local to the browser");
  assert.equal(existsSync(new URL("../app/admin/widgets/test-host/[section]/page.jsx", import.meta.url)), true);
  assert.equal(existsSync(new URL("../app/admin/widgets/test-host/frame/page.jsx", import.meta.url)), true);
});

test("the loader forwards the grant to every bootstrap call and the public demo page is gone", () => {
  const loader = readFileSync(new URL("../public/widget/v1/loader.js", import.meta.url), "utf8");
  assert.equal(loader.match(/\/bootstrap"/g).length, 1, "bootstrap URL is built in one place");
  assert.equal(loader.match(/fetch\(bootstrapUrl\(/g).length, 4);
  assert.match(loader, /script\.dataset\.testGrant/);
  assert.equal(existsSync(new URL("../public/widget-demo.html", import.meta.url)), false);
});
