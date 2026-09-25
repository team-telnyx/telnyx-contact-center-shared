import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COBROWSE, createDefaultWidgetConfig, isValidCobrowseSelector,
  parseWidgetConfig, assertPublishableWidgetConfig,
} from "../lib/widgets/config.js";
import {
  equalHash, freshCredential, generatePairingCode, hashCredential, pairingCodeHmac,
} from "../lib/cobrowse/credentials.mjs";
import { cobrowseSocketUrl } from "../lib/cobrowse/socket-url.mjs";
import { validateCaptureFrame, validateControlFrame } from "../lib/cobrowse/relay.mjs";
import { matchStoredOrigin } from "../lib/cobrowse/http.mjs";

test("co-browsing is absent from runtime activity until explicitly enabled", () => {
  const config = createDefaultWidgetConfig("en-US");
  assert.equal(config.cobrowse.enabled, false);
  assert.equal(DEFAULT_COBROWSE.control.maxLevel, "observe");
  assert.equal(DEFAULT_COBROWSE.recording.enabled, false);
  const legacy = structuredClone(config);
  delete legacy.cobrowse;
  assert.equal(parseWidgetConfig(legacy).cobrowse.enabled, false);
});

test("assisted control is opt-in and control frames are strictly bounded", () => {
  const config = createDefaultWidgetConfig("en-US");
  assert.equal(config.cobrowse.control.maxLevel, "observe");
  config.cobrowse.control.maxLevel = "assist";
  assert.equal(parseWidgetConfig(config).cobrowse.control.maxLevel, "assist");
  const base = { v: 1, type: "control", commandId: 1, epoch: "epoch_0123456789", seq: 4 };
  assert.equal(validateControlFrame({ ...base, action: "click", nodeId: 100 }), true);
  assert.equal(validateControlFrame({ ...base, action: "fill", selectionId: 1, value: "demo" }), true);
  assert.equal(validateControlFrame({ ...base, action: "scroll", deltaX: 0, deltaY: 400 }), true);
  assert.equal(validateControlFrame({ ...base, action: "fill", selectionId: 1, value: "x".repeat(501) }), false);
  assert.equal(validateControlFrame({ ...base, action: "fill", selectionId: 0, value: "demo" }), false);
  assert.equal(validateControlFrame({ ...base, action: "scroll", deltaX: 0, deltaY: 5000 }), false);
  assert.equal(validateControlFrame({ ...base, action: "click", nodeId: -1 }), false);
  assert.equal(validateControlFrame({ ...base, action: "click", nodeId: 100, commandId: 0 }), false);
  assert.equal(validateControlFrame({ ...base, action: "submit", nodeId: 100 }), false);
});

test("published privacy selectors are validated on the server", () => {
  for (const value of [".card-number", "[data-sensitive]", "input[type=password]", "section > .private", "#account .secret"])
    assert.equal(isValidCobrowseSelector(value), true, value);
  for (const value of ["a:has(img)", "div,script", "[x=]", "a{display:none}", "*[onclick]", "input:not(.safe)"])
    assert.equal(isValidCobrowseSelector(value), false, value);
  const config = createDefaultWidgetConfig("en-US");
  config.allowedOrigins = ["https://example.com"];
  config.cobrowse.enabled = true;
  config.cobrowse.privacy.maskSelectors = ["a:has(img)"];
  assert.throws(() => assertPublishableWidgetConfig(config));
});

test("pairing code is six digits and never stored as a fast digest", () => {
  process.env.COBROWSE_SIGNING_SECRET = "cobrowse-test-secret-at-least-thirty-two-characters";
  const code = generatePairingCode();
  assert.match(code, /^\d{6}$/);
  assert.match(pairingCodeHmac(code), /^[a-f0-9]{64}$/);
  assert.notEqual(pairingCodeHmac(code), hashCredential(code));
  const credential = freshCredential();
  assert.equal(equalHash(credential, hashCredential(credential)), true);
  assert.equal(equalHash(credential.slice(0, -1) + "x", hashCredential(credential)), false);
});

test("socket URL preserves configured /ws prefix and never carries a secret", () => {
  assert.equal(cobrowseSocketUrl("https://cc.example.com/api", { WS_BASE_URL: "wss://cc.example.com/ws" }), "wss://cc.example.com/ws/cobrowse");
  assert.equal(cobrowseSocketUrl("https://cc.example.com/api", {}), "wss://cc.example.com/ws/cobrowse");
  assert.equal(cobrowseSocketUrl("http://localhost:3000/api", {}), "ws://localhost:3001/cobrowse");
  assert.throws(() => cobrowseSocketUrl("https://cc.example.com", { WS_BASE_URL: "wss://cc.example.com/ws?secret=x" }));
});

test("browser origin must exactly match the bound publisher origin", () => {
  assert.equal(matchStoredOrigin("https://example.com", "https://example.com"), "https://example.com");
  assert.equal(matchStoredOrigin("https://example.com", "https://evil.example.com"), null);
  assert.equal(matchStoredOrigin("cc-test:https://cc.example.com", "https://cc.example.com"), "cc-test:https://cc.example.com");
});

test("relay accepts typed bounded observe-only frames", () => {
  const epoch = "epoch_0123456789";
  assert.equal(validateCaptureFrame({ v: 1, type: "snapshot", epoch, seq: 1, events: [{ type: 2 }] }), true);
  assert.equal(validateCaptureFrame({ v: 1, type: "events", epoch, seq: 2, events: [{ type: 3, data: { source: 0, adds: [] } }] }), true);
  assert.equal(validateCaptureFrame({ v: 1, type: "events", epoch, seq: 2, events: [{ type: 2 }] }), false);
  assert.equal(validateCaptureFrame({ v: 1, type: "pointer", epoch, seq: 2, events: [{ type: 3 }] }), false);
  assert.equal(validateCaptureFrame({ v: 1, type: "events", epoch, seq: 2, events: Array(101).fill({ type: 3 }) }), false);
  assert.equal(validateCaptureFrame({ v: 1, type: "events", epoch, seq: 2,
    events: [{ type: 3, data: { source: 0, adds: Array(1001).fill({}) } }] }), false);
});
