import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { whatsappMediaKind, validateWhatsAppMedia, validateOutboundWhatsAppText, normalizeInboundWhatsApp, describeWhatsAppContent, reduceWhatsAppDelivery,
  outboundStatusFromWhatsAppPayload, whatsappConversationWindow, buildWhatsAppTextMessage, buildWhatsAppMediaMessage, buildWhatsAppTemplateMessage, buildWhatsAppOutbound,
  describeTemplateSend, WHATSAPP_MEDIA_RULES, WHATSAPP_OUTBOUND_MIME_TYPES, WHATSAPP_MAX_TEXT_BYTES } from "../lib/whatsapp/policy.mjs";
import { whatsappMessageStatus } from "../lib/whatsapp/message-status.mjs";
import { validateTemplateDefinitionComponents, buildTemplateDefinitionComponents, templateVariableFields, templateRuntimeComponents, renderTemplateText, templateFormFromDefinition,
  templatePreviewParts, EMPTY_TEMPLATE_FORM } from "../lib/whatsapp/templates.mjs";
import { createWhatsAppMediaUrl, verifyWhatsAppMediaToken, whatsappMediaFilename, validateWhatsAppMediaBytes, toWhatsAppSticker, downloadWhatsAppMedia } from "../lib/whatsapp/media.mjs";
import { resolveWhatsAppCredentials, forgetWhatsAppCredentials, whatsappCredentialCandidates, whatsappProvider } from "../lib/whatsapp/provider.mjs";
import { whatsappWebhookUrl, whatsappWebhookUrlOrNull } from "../lib/whatsapp/webhook-url.mjs";
import { normalizePexelsPhoto, pexelsSearch, pexelsDownload } from "../lib/pexels.mjs";
import { normalizeWhatsAppPhone, isWhatsAppE164, statusTone, whatsappReadinessItems, normalizeWhatsAppSettings } from "../lib/whatsapp/admin-model.mjs";
import { RELEASED_CHANNELS, MESSAGING_CHANNELS, channelDefinition } from "../lib/acd/channel-registry.mjs";

beforeEach(() => {
  process.env.APP_BASE_URL = "https://contact.example.com"; process.env.TELNYX_WEBHOOK_PUBLIC_KEY = "primary-key"; process.env.NEXTAUTH_SECRET = "test-secret";
  delete process.env.TELNYX_WEBHOOK_BASE_URL; delete process.env.MEDIA_URL_SIGNING_SECRET; forgetWhatsAppCredentials();
});

test("WhatsApp is released as a messaging-family channel with its own tone", () => {
  assert.ok(RELEASED_CHANNELS.includes("whatsapp"));
  assert.ok(MESSAGING_CHANNELS.includes("whatsapp"));
  assert.equal(channelDefinition("whatsapp").viewer, "messages");
  assert.notEqual(channelDefinition("whatsapp").tone, channelDefinition("chat").tone);
});

test("media kinds and limits follow the WhatsApp specification", () => {
  assert.equal(whatsappMediaKind("image/jpeg", "a.jpg"), "image");
  assert.equal(whatsappMediaKind("image/png", "a.png", "sticker"), "sticker");
  assert.equal(whatsappMediaKind("image/webp", "a.webp"), "image");
  assert.equal(whatsappMediaKind("video/mp4", "a.mp4"), "video");
  assert.equal(whatsappMediaKind("audio/ogg", "a.ogg"), "audio");
  assert.equal(whatsappMediaKind("application/pdf", "a.pdf"), "document");
  assert.equal(whatsappMediaKind("application/octet-stream", "a.docx"), "document");
  assert.equal(whatsappMediaKind("application/x-msdownload", "a.exe"), null);
  assert.throws(() => validateWhatsAppMedia({ contentType: "image/jpeg", byteSize: 6 * 1048576, name: "big.jpg" }, "image"), /5 MB/);
  assert.throws(() => validateWhatsAppMedia({ contentType: "video/mp4", byteSize: 17 * 1048576 }, "video"), /16 MB/);
  assert.throws(() => validateWhatsAppMedia({ contentType: "image/webp", byteSize: 600 * 1024 }, "sticker"), /500 KB/);
  assert.deepEqual(validateWhatsAppMedia({ contentType: "application/pdf", byteSize: 1024, name: "x.pdf" }, "document"), { kind: "document", contentType: "application/pdf" });
  assert.ok(WHATSAPP_OUTBOUND_MIME_TYPES.includes("image/webp") && WHATSAPP_OUTBOUND_MIME_TYPES.includes("application/pdf"));
  assert.equal(WHATSAPP_MEDIA_RULES.audio.caption, false);
  assert.equal(validateOutboundWhatsAppText("  hi  "), "hi");
  assert.equal(validateOutboundWhatsAppText("", { allowEmpty: true }), "");
  assert.throws(() => validateOutboundWhatsAppText(""), /Enter a message/);
  assert.throws(() => validateOutboundWhatsAppText("ą".repeat(WHATSAPP_MAX_TEXT_BYTES / 2 + 1)), /4096 bytes/);
  assert.throws(() => validateOutboundWhatsAppText("x".repeat(1025), { caption: true }), /Captions/);
});

test("inbound payloads normalize text, nested media, generic media, locations, contacts, interactive replies and reactions", () => {
  const text = normalizeInboundWhatsApp({ id: "m1", type: "WHATSAPP", from: { phone_number: "+15550001111", display_name: "Anna" }, to: [{ phone_number: "+14155550100" }], text: "hello",
    whatsapp_message: { type: "text", text: { body: "hello" }, id: "wamid.1" }, received_at: "2026-09-15T10:00:00Z", messaging_profile_id: "mp-wa" });
  assert.deepEqual([text.providerId, text.from, text.to, text.kind, text.text, text.media, text.profileName, text.wamid], ["m1", "+15550001111", "+14155550100", "text", "hello", null, "Anna", "wamid.1"]);
  const image = normalizeInboundWhatsApp({ id: "m2", from: "+15550001111", to: "+14155550100", whatsapp_message: { type: "image", image: { url: "https://media.telnyx.com/x.jpg", mime_type: "image/jpeg; charset=binary", caption: "See this", sha256: "abc" } } });
  assert.deepEqual([image.kind, image.text, image.media.kind, image.media.url, image.media.contentType, image.media.caption, image.media.sha256], ["image", "See this", "image", "https://media.telnyx.com/x.jpg", "image/jpeg", "See this", "abc"]);
  const generic = normalizeInboundWhatsApp({ id: "m3", from: { phone_number: "+1" }, to: [{ phone_number: "+2" }], media: [{ url: "https://media.telnyx.com/v.mp4", content_type: "video/mp4", size: 10 }], whatsapp_message: { type: "video" } });
  assert.deepEqual([generic.kind, generic.media.kind, generic.media.contentType, generic.media.size], ["video", "video", "video/mp4", 10]);
  const insecure = normalizeInboundWhatsApp({ id: "m4", from: "+1", to: "+2", whatsapp_message: { type: "document", document: { link: "http://insecure/x.pdf" } } });
  assert.equal(insecure.media, null);
  const location = normalizeInboundWhatsApp({ id: "m5", from: "+1", to: "+2", whatsapp_message: { type: "location", location: { latitude: 52.2, longitude: 21.0, name: "Office", address: "Main St" } } });
  assert.deepEqual(location.location, { latitude: "52.2", longitude: "21", name: "Office", address: "Main St" });
  assert.equal(describeWhatsAppContent(location), "Office");
  const contacts = normalizeInboundWhatsApp({ id: "m6", from: "+1", to: "+2", whatsapp_message: { type: "contacts", contacts: [{ name: { formatted_name: "Jan Kowalski" }, phones: [{ phone: "+48123", type: "WORK" }], emails: [{ email: "jan@example.com" }] }] } });
  assert.deepEqual(contacts.contacts, [{ name: "Jan Kowalski", phones: ["+48123"], emails: ["jan@example.com"] }]);
  const reply = normalizeInboundWhatsApp({ id: "m7", from: "+1", to: "+2", whatsapp_message: { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } } });
  assert.deepEqual([reply.kind, reply.text, reply.interactiveReply], ["interactive", "Yes", { id: "yes", title: "Yes", description: "" }]);
  const reaction = normalizeInboundWhatsApp({ id: "m8", from: "+1", to: "+2", whatsapp_message: { type: "reaction", reaction: { message_id: "wamid.9", emoji: "👍" } } });
  assert.deepEqual([reaction.kind, describeWhatsAppContent({ ...reaction, text: "" })], ["reaction", "Reacted 👍"]);
  assert.equal(describeWhatsAppContent({ kind: "audio", text: "" }), "[Voice message]");
  assert.equal(describeWhatsAppContent({ kind: "document", text: "", media: { filename: "invoice.pdf" } }), "[Document: invoice.pdf]");
  assert.throws(() => normalizeInboundWhatsApp({ id: "x" }), /missing/);
});

test("delivery states are monotonic and read receipts follow delivery", () => {
  assert.equal(reduceWhatsAppDelivery({ status: "delivered", occurred_at: "2026-09-15T10:00:00Z" }, { status: "sent", occurredAt: "2026-09-15T10:01:00Z" }), null);
  assert.equal(reduceWhatsAppDelivery({ status: "delivered", occurred_at: "2026-09-15T10:00:00Z" }, { status: "read", occurredAt: "2026-09-15T10:01:00Z" })?.status, "read");
  assert.equal(reduceWhatsAppDelivery({ status: "read", occurred_at: "2026-09-15T10:00:00Z" }, { status: "delivered", occurredAt: "2026-09-15T10:02:00Z" }), null);
  assert.equal(reduceWhatsAppDelivery({ status: "sent", occurred_at: "2026-09-15T10:00:00Z" }, { status: "sent", occurredAt: "2026-09-15T09:00:00Z" }), null);
  assert.equal(reduceWhatsAppDelivery(null, { status: "rejected" })?.status, "failed");
  assert.equal(reduceWhatsAppDelivery(null, { status: "bogus" }), null);
  assert.deepEqual(outboundStatusFromWhatsAppPayload("message.read", { id: "1", to: [{ status: "read" }], read_at: "2026-09-15T10:00:00Z" }), { status: "read", occurredAt: "2026-09-15T10:00:00Z", errorCode: null, errorDetail: null });
  assert.equal(outboundStatusFromWhatsAppPayload("message.delivered", { id: "1" }).status, "delivered");
  assert.equal(outboundStatusFromWhatsAppPayload("message.finalized", { id: "1", to: [{ status: "delivered" }] }).status, "delivered");
  assert.equal(outboundStatusFromWhatsAppPayload("message.finalized", { id: "1", to: [{ status: "queued" }] }).status, "delivery_unconfirmed");
  const failed = outboundStatusFromWhatsAppPayload("message.failed", { id: "1", to: [{ status: "delivery_failed" }], errors: [{ code: "40300", detail: "Blocked" }] });
  assert.deepEqual([failed.status, failed.errorCode, failed.errorDetail], ["delivery_failed", "40300", "Blocked"]);
  assert.equal(whatsappMessageStatus({ sender_role: "agent", delivery: { status: "read" } }).label, "Read");
  assert.equal(whatsappMessageStatus({ sender_role: "agent", delivery: { status: "read" } }).tone, "read");
  assert.equal(whatsappMessageStatus({ sender_role: "customer" }).status, "received");
  assert.match(whatsappMessageStatus({ sender_role: "agent", delivery: { status: "delivery_failed", error_code: "1", error_detail: "nope" } }).title, /1 · nope/);
});

test("the 24-hour window and outbound payload builders", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(whatsappConversationWindow(null, now).open, false);
  assert.deepEqual(whatsappConversationWindow("2026-09-15T00:00:00Z", now), { open: true, expiresAt: "2026-09-16T00:00:00.000Z", remainingMs: 12 * 3600 * 1000 });
  assert.equal(whatsappConversationWindow("2026-09-14T11:59:00Z", now).open, false);
  assert.deepEqual(buildWhatsAppTextMessage("hi"), { type: "text", text: { body: "hi", preview_url: false } });
  assert.deepEqual(buildWhatsAppMediaMessage({ kind: "document", link: "https://x/y.pdf", caption: "Invoice", filename: "y.pdf" }), { type: "document", document: { link: "https://x/y.pdf", caption: "Invoice", filename: "y.pdf" } });
  assert.deepEqual(buildWhatsAppMediaMessage({ kind: "sticker", link: "https://x/s.webp", caption: "ignored" }), { type: "sticker", sticker: { link: "https://x/s.webp" } });
  assert.deepEqual(buildWhatsAppTemplateMessage({ templateId: "t1", components: [] }), { type: "template", template: { template_id: "t1" } });
  assert.deepEqual(buildWhatsAppTemplateMessage({ name: "order", language: "en_US", components: [{ type: "body", parameters: [{ type: "text", text: "1" }] }] }).template, { name: "order", language: { policy: "deterministic", code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "1" }] }] });
  assert.throws(() => buildWhatsAppTemplateMessage({}), /template/);
  assert.deepEqual(buildWhatsAppOutbound({ from: "+1", to: "+2", message: { type: "text", text: { body: "x", preview_url: false } }, webhookUrl: "https://contact.example.com/api/webhooks/telnyx/whatsapp" }),
    { from: "+1", to: "+2", type: "WHATSAPP", whatsapp_message: { type: "text", text: { body: "x", preview_url: false } }, webhook_url: "https://contact.example.com/api/webhooks/telnyx/whatsapp" });
  // Telnyx requires the sending profile for WhatsApp-only numbers (error 40305 otherwise).
  assert.deepEqual(buildWhatsAppOutbound({ from: "+1", to: "+2", message: { type: "text", text: { body: "x", preview_url: false } }, messagingProfileId: "4001a0a3" }),
    { from: "+1", to: "+2", type: "WHATSAPP", whatsapp_message: { type: "text", text: { body: "x", preview_url: false } }, messaging_profile_id: "4001a0a3" });
  assert.equal(describeTemplateSend({ name: "order_update", language: "en_US", components: [{ type: "body", parameters: [{ type: "text", text: "Anna" }, { type: "text", text: "1234" }] }] }), "Template “order_update” (en_US): Anna · 1234");
  assert.equal(whatsappWebhookUrl(), "https://contact.example.com/api/webhooks/telnyx/whatsapp");
  process.env.APP_BASE_URL = "http://localhost:3000";
  assert.throws(() => whatsappWebhookUrl(), /HTTPS/);
  assert.equal(whatsappWebhookUrlOrNull(), null);
});

test("template builders, validation, variables, runtime components and rendering", () => {
  const form = { ...EMPTY_TEMPLATE_FORM, name: "order_update", category: "UTILITY", language: "en_US", headerFormat: "TEXT", headerText: "Order {{1}}", bodyText: "Hi {{1}}, your order {{2}} shipped.", footerText: "Thanks",
    variableExamples: { "header:1": "1234", "body:1": "Anna", "body:2": "1234", "button:0": "1234" }, buttons: [{ type: "URL", text: "Track", url: "https://example.com/track/{{1}}" }, { type: "QUICK_REPLY", text: "Thanks" }] };
  const components = buildTemplateDefinitionComponents(form);
  assert.deepEqual(components[0], { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["1234"] } });
  assert.deepEqual(components[1], { type: "BODY", text: "Hi {{1}}, your order {{2}} shipped.", example: { body_text: [["Anna", "1234"]] } });
  assert.deepEqual(components[2], { type: "FOOTER", text: "Thanks" });
  assert.deepEqual(components[3].buttons, [{ type: "URL", text: "Track", url: "https://example.com/track/{{1}}", example: ["1234"] }, { type: "QUICK_REPLY", text: "Thanks" }]);
  assert.deepEqual(validateTemplateDefinitionComponents(components, "UTILITY"), []);
  assert.match(validateTemplateDefinitionComponents([{ type: "BODY", text: "{{1}} starts" }], "UTILITY").join(" "), /cannot start/);
  assert.match(validateTemplateDefinitionComponents([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", text: "t", url: "https://a/{{2}}" }] }], "UTILITY").join(" "), /exactly \{\{1\}\}/);
  assert.match(validateTemplateDefinitionComponents([{ type: "HEADER", format: "TEXT", text: "h" }, { type: "BODY" }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy" }] }], "AUTHENTICATION").join(" "), /cannot include a header/);
  const auth = buildTemplateDefinitionComponents({ ...EMPTY_TEMPLATE_FORM, category: "AUTHENTICATION", authenticationCopyCodeText: "Copy code", authenticationCodeExpirationMinutes: 5 });
  assert.deepEqual(validateTemplateDefinitionComponents(auth, "AUTHENTICATION"), []);
  const template = { id: "t1", name: "order_update", language: "en_US", category: "UTILITY", status: "APPROVED", components };
  const fields = templateVariableFields(template);
  assert.deepEqual(fields.map((f) => f.key), ["header:1", "body:1", "body:2", "button:0"]);
  const runtime = templateRuntimeComponents(fields, { "header:1": "77", "body:1": "Ola", "body:2": "77", "button:0": "77" });
  assert.deepEqual(runtime, [{ type: "header", parameters: [{ type: "text", text: "77" }] }, { type: "body", parameters: [{ type: "text", text: "Ola" }, { type: "text", text: "77" }] }, { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: "77" }] }]);
  assert.equal(renderTemplateText(template, { "header:1": "77", "body:1": "Ola", "body:2": "77" }), "Order 77\nHi Ola, your order 77 shipped.\nThanks");
  assert.equal(templatePreviewParts({ category: "AUTHENTICATION", components: auth }).body, "{{1}} is your verification code. For your security, do not share this code.");
  const roundTrip = templateFormFromDefinition(template);
  assert.deepEqual([roundTrip.name, roundTrip.headerFormat, roundTrip.headerText, roundTrip.bodyText, roundTrip.footerText, roundTrip.buttons.length, roundTrip.variableExamples["body:2"]], ["order_update", "TEXT", "Order {{1}}", "Hi {{1}}, your order {{2}} shipped.", "Thanks", 2, "1234"]);
  assert.deepEqual(buildTemplateDefinitionComponents(roundTrip), components);
});

test("outbound media links are signed, expiring and refuse tampering", () => {
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const url = new URL(createWhatsAppMediaUrl(id, { now: 1_000_000 }));
  assert.equal(url.origin + url.pathname, `https://contact.example.com/api/public/whatsapp-media/${id}`);
  assert.equal(verifyWhatsAppMediaToken(id, url.searchParams.get("exp"), url.searchParams.get("sig"), 1_000_001), true);
  assert.equal(verifyWhatsAppMediaToken(id, url.searchParams.get("exp"), url.searchParams.get("sig"), Number(url.searchParams.get("exp")) + 1), false, "expired");
  assert.equal(verifyWhatsAppMediaToken(id, url.searchParams.get("exp"), "0".repeat(64), 1_000_001), false, "bad signature");
  assert.equal(verifyWhatsAppMediaToken("not-a-uuid", url.searchParams.get("exp"), url.searchParams.get("sig"), 1_000_001), false);
  process.env.APP_BASE_URL = "http://localhost:3000";
  assert.throws(() => createWhatsAppMediaUrl(id), /HTTPS/);
  assert.equal(whatsappMediaFilename({ kind: "image", filename: "", contentType: "image/jpeg", providerMessageId: "abc-1" }), "image-abc-1.jpg");
  assert.equal(whatsappMediaFilename({ kind: "document", filename: "Invoice 12.pdf", contentType: "application/pdf" }), "Invoice 12.pdf");
  assert.equal(whatsappMediaFilename({ kind: "audio", filename: "voice", contentType: "audio/ogg; codecs=opus", providerMessageId: "x" }), "voice.ogg");
});

test("magic-number checks, sticker conversion and bounded downloads", async () => {
  const { default: sharp } = await import("sharp");
  const png = await sharp({ create: { width: 800, height: 400, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
  validateWhatsAppMediaBytes(png, "image/png");
  validateWhatsAppMediaBytes(Buffer.from("%PDF-1.7\n"), "application/pdf");
  validateWhatsAppMediaBytes(Buffer.from("OggS\0\0"), "audio/ogg");
  validateWhatsAppMediaBytes(Buffer.from("#!AMR\n"), "audio/amr");
  assert.throws(() => validateWhatsAppMediaBytes(png, "image/jpeg"), /does not match/);
  assert.throws(() => validateWhatsAppMediaBytes(Buffer.alloc(0), "image/png"), /does not match/);
  const sticker = await toWhatsAppSticker(png);
  const meta = await sharp(sticker).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 512, 512]);
  assert.ok(sticker.length <= 100 * 1024);
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), headers: options.headers }); return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } }); };
  const downloaded = await downloadWhatsAppMedia("https://media.telnyx.com/a.png", { apiKey: "secret", fetchImpl });
  assert.equal(downloaded.contentType, "image/png");
  assert.equal(downloaded.bytes.length, png.length);
  assert.equal(calls[0].headers.Authorization, "Bearer secret", "Telnyx hosts receive the API key");
  await downloadWhatsAppMedia("https://cdn.example.com/a.png", { apiKey: "secret", fetchImpl });
  assert.equal(calls[1].headers.Authorization, undefined, "other hosts never receive the API key");
  await assert.rejects(downloadWhatsAppMedia("http://media.telnyx.com/a.png", { fetchImpl }), /HTTPS/);
  await assert.rejects(downloadWhatsAppMedia("https://media.telnyx.com/a.png", { fetchImpl, maxBytes: 10 }), /storage limit/);
});

test("credentials resolve to the first Telnyx account that owns a WhatsApp Business Account", async () => {
  const env = { TELNYX_API_KEY: "primary", TELNYX_API_KEY_WHATSAPP: "backup" };
  assert.deepEqual(whatsappCredentialCandidates(env).map((c) => c.source), ["primary", "backup"]);
  const seen = [];
  const fetchImpl = async (url, options) => { const key = options.headers.Authorization.replace("Bearer ", ""); seen.push(key); return new Response(JSON.stringify({ data: key === "backup" ? [{ id: "waba-1" }] : [] }), { status: 200 }); };
  const resolved = await resolveWhatsAppCredentials({ fetchImpl, env, force: true });
  assert.deepEqual([resolved.source, resolved.apiKey, resolved.resolved, resolved.accounts.length], ["backup", "backup", true, 1]);
  assert.deepEqual(resolved.checks.map((c) => [c.source, c.wabaCount]), [["primary", 0], ["backup", 1]]);
  assert.deepEqual(seen, ["primary", "backup"]);
  const cached = await resolveWhatsAppCredentials({ fetchImpl, env });
  assert.equal(cached, resolved, "cached for five minutes");
  assert.equal(seen.length, 2);
  forgetWhatsAppCredentials();
  const failing = await resolveWhatsAppCredentials({ fetchImpl: async () => new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), { status: 401 }), env: { TELNYX_API_KEY: "only" }, force: true });
  assert.deepEqual([failing.source, failing.resolved, failing.checks[0].error, failing.checks[1].configured], ["primary", false, "Unauthorized", false]);
  const provider = whatsappProvider({ name: "inner", send: async () => ({ outcome: "accepted" }) }, async (path, options) => ({ data: { id: "wa-1", to: [{ status: "queued" }] }, path, options }));
  assert.equal((await provider.send({ operation: "whatsapp_send", request: { from: "+1" } })).outcome, "accepted");
  assert.equal((await provider.send({ operation: "other" })).outcome, "accepted");
  const rejecting = whatsappProvider(null, async () => { throw Object.assign(new Error("Bad request"), { status: 422, code: "40001" }); });
  assert.deepEqual(await rejecting.send({ operation: "whatsapp_send", request: {} }), { outcome: "failed", httpStatus: 422, response: { error: "Bad request", code: "40001" } });
  const lost = whatsappProvider(null, async () => { throw new Error("socket hang up"); });
  assert.equal((await lost.send({ operation: "whatsapp_send", request: {} })).outcome, "ambiguous");
});

test("Pexels client normalizes photos, searches and downloads only images.pexels.com renditions", async () => {
  process.env.PEXELS_API_KEY = "pexels-key";
  const photo = { id: 42, alt: "Sunset", photographer: "Kim", photographer_url: "https://pexels.com/@kim", url: "https://pexels.com/photo/42", width: 4000, height: 3000, avg_color: "#112233", src: { medium: "https://images.pexels.com/photos/42/m.jpeg", large: "https://images.pexels.com/photos/42/l.jpeg" } };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), auth: options?.headers?.Authorization });
    if (String(url).startsWith("https://api.pexels.com/v1/search")) return new Response(JSON.stringify({ photos: [photo], page: 1, per_page: 30, total_results: 1 }), { status: 200 });
    if (String(url).startsWith("https://api.pexels.com/v1/photos/42")) return new Response(JSON.stringify(photo), { status: 200 });
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const search = await pexelsSearch({ query: "sunset", perPage: 5 }, fetchImpl);
  assert.equal(search.photos[0].title, "Sunset");
  assert.equal(requests[0].auth, "pexels-key");
  await assert.rejects(pexelsSearch({ query: "a" }, fetchImpl), /at least 2/);
  const file = await pexelsDownload(42, fetchImpl);
  assert.deepEqual([file.contentType, file.filename, file.bytes.length], ["image/jpeg", "sunset-42.jpg", 4]);
  assert.equal(requests.at(-1).url, "https://images.pexels.com/photos/42/l.jpeg");
  await assert.rejects(pexelsDownload("nope", fetchImpl), /valid Pexels/);
  assert.equal(normalizePexelsPhoto({ id: 1 }).title, "Pexels photo 1");
  delete process.env.PEXELS_API_KEY;
  await assert.rejects(pexelsSearch({ query: "sunset" }, fetchImpl), /not configured/);
});

test("admin model normalizers", () => {
  assert.equal(normalizeWhatsAppPhone("+1 (415) 555-0100"), "+14155550100");
  assert.equal(isWhatsAppE164("+14155550100"), true);
  assert.equal(isWhatsAppE164("4155550100"), false);
  assert.deepEqual([statusTone("CONNECTED"), statusTone("PENDING_REVIEW"), statusTone("REJECTED"), statusTone("weird")], ["success", "warning", "danger", "neutral"]);
  const readiness = whatsappReadinessItems({ accountReviewStatus: "APPROVED", businessVerificationStatus: "verified" }, { webhookEnabled: false }, [{ enabled: true, status: "CONNECTED" }]);
  assert.deepEqual(readiness.map((item) => item.ready), [true, true, true, false]);
  assert.deepEqual(normalizeWhatsAppSettings({ webhook_enabled: true, webhook_events: ["messages"] }).webhookEvents, ["messages"]);
});
