import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WIDGET_CONFIG, assertPublishableWidgetConfig, parseWidgetConfig, publicWidgetConfig } from "../lib/widgets/config.js";
import { evaluateWidgetDecisions } from "../lib/widgets/decisions.js";
import { widgetTranslations } from "../lib/widgets/locales.js";

function baseConfig(overrides = {}) {
  const config = parseWidgetConfig(DEFAULT_WIDGET_CONFIG);
  config.allowedOrigins = ["https://customer.example.com"];
  return { ...config, ...overrides };
}

test("legacy revisions parse with the video channel disabled and the public projection hides routing", () => {
  const legacy = structuredClone(DEFAULT_WIDGET_CONFIG);
  delete legacy.channels.video;
  const parsed = parseWidgetConfig(legacy);
  assert.equal(parsed.channels.video.enabled, false);
  assert.deepEqual(parsed.channels.video.recording, { enabled: true, layout: "pip" });
  // A phase 1 revision: `defaultLayout` and a bare `waitingMedia` list migrate to scenes and the waiting playlist.
  const enabled = parseWidgetConfig({ ...parsed, channels: { ...parsed.channels, video: { ...parsed.channels.video, enabled: true, defaultLayout: "split", scenes: undefined, waiting: undefined,
    routing: { queueId: "q-video", queueName: "Video" }, waitingMedia: [{ url: "https://cdn.example.com/ad.mp4", label: "Promo" }] } } });
  assert.deepEqual(enabled.channels.video.scenes, { available: ["remote", "split", "pip", "spotlight"], default: "split", pipThumbnail: 30 });
  assert.deepEqual(enabled.channels.video.waiting, { mode: "loop", sound: true, items: [{ source: "url", url: "https://cdn.example.com/ad.mp4", mediaId: "", label: "Promo" }] });
  assert.equal("defaultLayout" in enabled.channels.video, false);
  const pub = publicWidgetConfig(enabled).channels.video;
  assert.deepEqual(pub, { enabled: true, camera: "on", scenes: { available: ["remote", "split", "pip", "spotlight"], default: "split", pipThumbnail: 30 }, modal: { enabled: true, size: "medium" },
    sizing: { mode: "widget", width: 480, height: 640 }, controls: { position: "bottom", overlay: { opacity: 35, size: "regular" } }, notices: { enabled: true, seconds: 3 }, allowScreenShare: false, recording: true,
    waiting: { mode: "loop", sound: true, items: [{ url: "https://cdn.example.com/ad.mp4", label: "Promo" }] } });
  assert.equal("routing" in pub, false, "queue ids never reach the embedding page");
  assert.throws(() => parseWidgetConfig({ ...enabled, channels: { ...enabled.channels, video: { ...enabled.channels.video, waiting: { mode: "rotate", items: [{ source: "url", url: "http://insecure.example.com/ad.mp4" }] } } } }), /HTTPS/);
  assert.throws(() => parseWidgetConfig({ ...enabled, channels: { ...enabled.channels, video: { ...enabled.channels.video, waiting: { mode: "rotate", items: [{ source: "url", url: "https://%%%%" }] } } } }), /HTTPS/);
  // Library items resolve to the ranged media route and never expose storage; the default scene must be available.
  const library = parseWidgetConfig({ ...enabled, channels: { ...enabled.channels, video: { ...enabled.channels.video, scenes: { available: ["pip", "spotlight"], default: "split" },
    waiting: { mode: "rotate", items: [{ source: "library", mediaId: "m-1", label: "Promo" }, { source: "url", url: "https://cdn.example.com/b.mp4" }] } } } });
  assert.deepEqual(library.channels.video.scenes, { available: ["pip", "spotlight"], default: "pip", pipThumbnail: 30 });
  assert.deepEqual(publicWidgetConfig(library).channels.video.waiting.items, [{ url: "/api/video/media/m-1", label: "Promo" }, { url: "https://cdn.example.com/b.mp4", label: "" }]);
  assert.throws(() => parseWidgetConfig({ ...enabled, channels: { ...enabled.channels, video: { ...enabled.channels.video, waiting: { mode: "loop", items: [{ source: "library" }] } } } }), /media library/);
});

test("publishing a widget with video requires a queue; video alone satisfies the channel requirement", () => {
  const config = baseConfig();
  config.channels.messaging.enabled = false;
  config.channels.voice.enabled = false;
  config.channels.video.enabled = true;
  assert.throws(() => assertPublishableWidgetConfig(config), /Select a Contact Center video queue/);
  config.channels.video.routing = { queueId: "q-video", queueName: "Video" };
  assert.equal(assertPublishableWidgetConfig(config).channels.video.routing.queueId, "q-video");
  const none = baseConfig();
  none.channels.messaging.enabled = false; none.channels.voice.enabled = false; none.channels.video.enabled = false;
  assert.throws(() => parseWidgetConfig(none), /At least one channel must be enabled/);
});

test("decision rules can allow the video channel explicitly, keep 'both' as messaging plus voice, and offer 'all'", () => {
  const config = baseConfig();
  config.channels.video.enabled = true;
  config.channels.video.routing = { queueId: "q-video", queueName: "Video" };
  config.channels.voice.enabled = true;
  config.decisions = { ...config.decisions, enabled: true, rules: [{ id: "r1", name: "video only", description: "", enabled: true, priority: 10, match: "all",
    conditions: [{ id: "c1", field: "page.path", operator: "starts-with", value: "/sales" }],
    actions: [{ id: "a1", type: "channels", value: "video", valueLabel: "Video" }] }] };
  const parsed = parseWidgetConfig(config);
  const sales = evaluateWidgetDecisions(parsed, { "page.path": "/sales/pricing" });
  assert.deepEqual(sales.channels, ["video"]);
  assert.equal(sales.config.channels.messaging.enabled, false);
  parsed.decisions.rules[0].actions[0].value = "both";
  assert.deepEqual(evaluateWidgetDecisions(parsed, { "page.path": "/sales" }).channels, ["messaging", "voice"]);
  parsed.decisions.rules[0].actions[0].value = "all";
  assert.deepEqual(evaluateWidgetDecisions(parsed, { "page.path": "/sales" }).channels, ["messaging", "voice", "video"]);
  assert.deepEqual(evaluateWidgetDecisions(parsed, { "page.path": "/help" }).channels, ["messaging", "voice", "video"]);
});

test("every widget locale exposes the video strings, falling back to English where untranslated", () => {
  for (const locale of ["en-US", "pl-PL", "de-DE", "fr-FR", "es-ES", "ar-SA", "he-IL"]) {
    const ui = widgetTranslations(locale);
    assert.equal(typeof ui.video.layoutPip, "string", locale);
    assert.ok(ui.content.videoLabel, locale);
    assert.ok(ui.aria.home, locale);
  }
  assert.equal(widgetTranslations("pl-PL").video.layoutPip, "Obraz w obrazie");
  assert.equal(widgetTranslations("de-DE").video.layoutPip, "Picture in picture");
});
