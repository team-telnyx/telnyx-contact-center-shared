import test from "node:test";
import assert from "node:assert/strict";
import { assistantVisionToolStatus, hasAssistantVisionTool } from "../lib/ai/vision-tool.mjs";
import { validateVideoVisionTool } from "../lib/video/ai-profiles.mjs";
import { videoAiSchema } from "../lib/video/conference-config.mjs";
import { requestConferenceAi } from "../lib/video/conference.mjs";

const source = { id: "test", name: "Test assistant", model: "image-model", tools: [] };
const models = { data: [{ id: source.model, is_vision_supported: true, recommended_for_assistants: true }] };
const ai = videoAiSchema.parse({ vision: { mode: "live" } });
test("missing Vision blocks publication unless adding the tool was selected", async () => {
  assert.equal(ai.vision.addToolOnPublish, false);
  await assert.rejects(validateVideoVisionTool(source, ai, async () => models), /no Vision tool/);
  await validateVideoVisionTool(source, { ...ai, vision: { ...ai.vision, addToolOnPublish: true } }, async () => models);
  await validateVideoVisionTool({ ...source, tools: [{ type: "vision" }] }, ai, async () => models);
  await assert.rejects(validateVideoVisionTool(source, { ...ai, vision: { ...ai.vision, addToolOnPublish: true } }, async () => ({ data: [] })), /could not be verified/);
});

test("shared Vision is resolved and a failed lookup never claims the tool exists", async () => {
  const shared = { ...source, tool_ids: ["shared-vision"] };
  assert.equal(assistantVisionToolStatus(shared), "unknown");
  assert.equal(assistantVisionToolStatus(source), "missing");
  assert.equal(assistantVisionToolStatus({ tools: [{ type: "vision", tool_id: "shared-vision" }], tool_ids: ["shared-vision"] }), "present");
  assert.equal(await hasAssistantVisionTool(shared, async path => { assert.equal(path, "/ai/tools/shared-vision"); return { data: { type: "vision" } }; }), true);
  assert.equal(await hasAssistantVisionTool(shared, async () => ({ data: { type: "webhook" } })), false);
  await assert.rejects(hasAssistantVisionTool(shared, async () => { throw Error("Tool unavailable"); }), /unavailable/);
});

test("detached shared Vision cannot satisfy publication or tool readiness", async () => {
  const stale = { ...source, tools: [{ type: "vision", tool_id: "detached-vision" }], tool_ids: [] };
  assert.equal(assistantVisionToolStatus(stale), "missing");
  assert.equal(await hasAssistantVisionTool(stale, async () => assert.fail("Detached tools must not be resolved")), false);
  await assert.rejects(validateVideoVisionTool(stale, ai, async () => models), /no Vision tool/);

  const unresolved = { ...stale, tool_ids: ["active-tool"] };
  assert.equal(assistantVisionToolStatus(unresolved), "unknown");
  assert.equal(await hasAssistantVisionTool(unresolved, async path => {
    assert.equal(path, "/ai/tools/active-tool");
    return { data: { type: "webhook" } };
  }), false);
  assert.equal(assistantVisionToolStatus({ ...stale, tools: [...stale.tools, { type: "vision" }] }), "present");
  assert.equal(assistantVisionToolStatus({ ...stale, tool_ids: undefined }), "present");
});

test("starting AI rejects a published profile whose Vision tool was removed", async t => {
  const previousKey = process.env.TELNYX_API_KEY;
  process.env.TELNYX_API_KEY = "controlled-test-only";
  t.after(() => { if (previousKey === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = previousKey; });
  let saved = source;
  t.mock.method(globalThis, "fetch", async url => Response.json(String(url).endsWith("/ai/openai/models") ? models : saved));
  const db = { async query(sql) {
    if (sql.includes("FROM acd_video_sessions")) return { rows: [{ state: "active", conversation_id: "conversation", conference_config: { ai: { ...ai, assistantId: source.id } } }] };
    if (sql.includes("FROM cc_video_ai_profiles")) return { rows: [{ config: ai, assistant_id: source.id }] };
    if (sql.includes("FROM cc_video_ai_workers")) return { rowCount: 1 };
    assert.fail("No AI job may be inserted without its required Vision tool");
  } };
  await assert.rejects(requestConferenceAi(db, { videoSessionId: "video" }), error => error.status === 409 && /no Vision tool/.test(error.message));
  saved = { ...source, tools: [{ type: "vision", tool_id: "detached-vision" }], tool_ids: [] };
  await assert.rejects(requestConferenceAi(db, { videoSessionId: "video" }), error => error.status === 409 && /no Vision tool/.test(error.message));
});
