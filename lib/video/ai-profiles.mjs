import { validateAssistantVision } from "../ai/vision-validation.mjs";
import { hasAssistantVisionTool } from "../ai/vision-tool.mjs";
import { createHash, randomUUID } from "node:crypto";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { planAssistantToolSave } from "../ai/shared-tool-sync.mjs";
import { extractSharedToolIds } from "../ai/tool-library.js";
import { getTelnyxAvatar } from "../ai/telnyx-avatars.mjs";
import { hasCompatibleAvatarVoice } from "../ai/assistant-avatar-ui.mjs";
import { videoAssistantIds, videoUsesAi } from "./conference-config.mjs";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const unwrap = result => result.data || result;
export const profileHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function validateVideoVisionTool(source, ai, request = widgetAiRequest) {
  if (ai.vision.mode === "disabled") return;
  await validateAssistantVision(source, { request, buffered: true });
  if (!await hasAssistantVisionTool(source, request) && ai.vision.addToolOnPublish !== true) {
    throw fail(`The assistant ${source.name || source.id} has no Vision tool. Add Vision to the assistant or enable Add Vision tool on publish for the video profile.`);
  }
}

export function assertVideoAssistant(source, ai) {
  if (source.conversation_flow) throw fail("Video conferences currently require an assistant without a conversation workflow");
  if (ai.avatar.enabled && !hasCompatibleAvatarVoice(source.voice_settings) && !(/^openai\/gpt-live/.test(source.model) && /^OpenAILive\./.test(source.voice_settings?.voice))) throw fail("The selected video avatar requires Telnyx TTS or GPT Live");
  if (ai.vision.mode !== "disabled" && /^openai\/gpt-live/.test(source.model)) throw fail("Vision buffering is unavailable with GPT Live. Select a vision-capable text model with Telnyx TTS.");
  if ((source.tools || []).some(t => ["transfer", "send_dtmf", "handoff", "client_side_tool"].includes(t.type))) throw fail("The video assistant contains telephone transfer, delegation or custom client tools. Choose a video-specific source assistant; conference handoff is added automatically.");
}
export function videoHandoffTool() {
  return { type: "client_side_tool", timeout_ms: 10000, client_side_tool: {
    name: "cc_video_handoff", description: "Bring a human agent into this Contact Center video room when the customer requests a human. All participants stay in the same room. This is not a telephone transfer.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "Concise factual summary for the agent" }, reason: { type: "string" } }, required: ["summary", "reason"] },
  } };
}
export async function preflightVideoAi(db, video, { request = widgetAiRequest } = {}) {
  if (!video.enabled) return;
  const queue = await db.query(`SELECT 1 FROM cc_queues q JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='video' AND c.enabled WHERE q.id=$1 AND q.enabled`, [video.routing.queueId]);
  if (!queue.rowCount) throw fail("The fallback queue must be enabled for Video");
  if (!videoUsesAi(video)) return;
  if (process.env.VIDEO_CONFERENCE_AI_ENABLED === "false") throw fail("Conference AI is disabled", 503);
  if (video.ai.vision.mode !== "disabled" && process.env.VIDEO_VISION_ENABLED === "false") throw fail("Conference Vision is disabled", 503);
  for (const id of videoAssistantIds(video)) {
    const source = unwrap(await request(`/ai/assistants/${encodeURIComponent(id)}`));
    assertVideoAssistant(source, video.ai);
    await validateVideoVisionTool(source, video.ai, request);
  }
  if (video.ai.avatar.enabled) await getTelnyxAvatar(video.ai.avatar.avatarId, { request });
}

// Profiles are private managed clones per publication. Existing voice widgets
// and the operational source assistant are never changed by video settings.
export async function provisionVideoProfiles(pool, { widgetId, revisionId, video, beforeMutation = async () => {}, request = widgetAiRequest }) {
  if (!video.enabled || !videoUsesAi(video)) return [];
  const connection = await pool.connect();
  let locked = false;
  try {
    locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,814025)) AS acquired", [revisionId])).rows[0].acquired;
    if (!locked) throw fail("Another publication is preparing this video profile. Retry shortly.", 409);
    const profiles = [];
    for (const sourceId of videoAssistantIds(video)) {
      const source = unwrap(await request(`/ai/assistants/${encodeURIComponent(sourceId)}`));
      assertVideoAssistant(source, video.ai);
      await validateVideoVisionTool(source, video.ai, request);
      const configHash = profileHash(video.ai);
      let profile = (await connection.query("SELECT * FROM cc_video_ai_profiles WHERE revision_id=$1 AND source_assistant_id=$2", [revisionId, sourceId])).rows[0];
      if (profile?.status === "ready" && profile.source_hash === profileHash(source) && profileHash(profile.config) === configHash) {
        // A previous publication attempt may have prepared this draft. Verify
        // the provider again: a cached row cannot prove the tool still exists.
        const saved = unwrap(await request(`/ai/assistants/${encodeURIComponent(profile.assistant_id)}`));
        if (video.ai.vision.mode === "disabled" || await hasAssistantVisionTool(saved, request)) { profiles.push(profile); continue; }
      }
      if (profile) {
        const editable = await connection.query(`SELECT 1 FROM cc_widget_revisions r WHERE r.id=$1 AND r.state='draft'
          AND NOT EXISTS(SELECT 1 FROM cc_video_ai_sessions a WHERE a.profile_id=$2)`, [revisionId, profile.id]);
        if (!editable.rowCount) throw fail("An active publication cannot be modified. Save changes in the current draft.", 409);
        if (profile.assistant_id.startsWith("pending:")) throw fail("The previous profile creation has an unknown outcome. Its provisioning record must be reconciled before retrying.", 409);
        await beforeMutation();
        try { await request(`/ai/assistants/${encodeURIComponent(profile.assistant_id)}`, { method: "DELETE" }); }
        catch (error) { if (error.status !== 404) throw error; }
        await connection.query("DELETE FROM cc_video_ai_profiles WHERE id=$1", [profile.id]);
      }
      const id = randomUUID();
      await beforeMutation();
      await connection.query(`INSERT INTO cc_video_ai_profiles(id,widget_id,revision_id,source_assistant_id,assistant_id,source_hash,config,status)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'provisioning')`, [id, widgetId, revisionId, sourceId, `pending:${id}`, profileHash(source), JSON.stringify(video.ai)]);
      let cloned;
      try {
        cloned = unwrap(await request(`/ai/assistants/${encodeURIComponent(sourceId)}/clone`, { method: "POST", body: { name: `CC video profile ${id}` } }));
        if (!cloned.id) throw fail("Telnyx did not confirm the cloned assistant", 502);
        await connection.query("UPDATE cc_video_ai_profiles SET assistant_id=$2 WHERE id=$1", [id, cloned.id]);
        const current = unwrap(await request(`/ai/assistants/${encodeURIComponent(cloned.id)}`));
        const tools = (current.tools || []).filter(t => t.type !== "vision" && t.client_side_tool?.name !== "cc_video_handoff");
        tools.push(videoHandoffTool());
        if (video.ai.vision.mode !== "disabled") tools.push({ type: "vision", vision: { max_frame_age_secs: 10 } });
        const avatar = video.ai.avatar;
        const settings = avatar.enabled ? { provider: "telnyx", model: "foxtrot-1", avatar_id: avatar.avatarId, background_id: avatar.backgroundId } : null;
        await beforeMutation();
        const toolIds = [...extractSharedToolIds(tools)];
        for (const toolId of extractSharedToolIds(current.tools || [])) {
          if (!toolIds.includes(toolId)) await request(`/ai/assistants/${encodeURIComponent(cloned.id)}/tools/${encodeURIComponent(toolId)}`, { method: "DELETE" });
        }
        await request(`/ai/assistants/${encodeURIComponent(cloned.id)}`, { method: "POST", body: { name: `CC video profile ${id}`, ...planAssistantToolSave({ tools, tool_ids: toolIds }, { currentTools: current.tools || [] }).updatePayload, avatar_settings: settings,
          instructions: `${current.instructions || ""}\n\nVideo conference rules: This is a shared video room, not a telephone call. Use cc_video_handoff when the customer asks for a human. Never expose private integration tokens. After a human joins, speak only when addressed and use skip_turn if available. Vision sees only the explicitly selected source; always check a fresh frame before describing current visual content.`,
        } });
        const saved = unwrap(await request(`/ai/assistants/${encodeURIComponent(cloned.id)}`));
        if (saved.model !== source.model || (saved.avatar_settings?.avatar_id || null) !== (settings?.avatar_id || null)
          || await hasAssistantVisionTool(saved, request) !== (video.ai.vision.mode !== "disabled")
          || !saved.tools?.some(t => t.client_side_tool?.name === "cc_video_handoff")) throw fail("The managed video profile did not pass read-back verification", 502);
        profile = (await connection.query("UPDATE cc_video_ai_profiles SET status='ready',source_name=$2 WHERE id=$1 RETURNING *", [id, source.name || sourceId])).rows[0];
        profiles.push(profile);
      } catch (error) {
        await connection.query("UPDATE cc_video_ai_profiles SET status='failed' WHERE id=$1", [id]);
        if (cloned?.id) {
          try { await request(`/ai/assistants/${encodeURIComponent(cloned.id)}`, { method: "DELETE" }); await connection.query("DELETE FROM cc_video_ai_profiles WHERE id=$1", [id]); } catch { /* Recorded for the profile reaper; never delete a source assistant. */ }
        }
        throw error;
      }
    }
    return profiles;
  } finally {
    try { if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,814025))", [revisionId]); } finally { connection.release(); }
  }
}

export async function retireVideoProfiles(pool, { request = widgetAiRequest } = {}) {
  const db = await pool.connect(); let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(814025,2) AS ok")).rows[0].ok;
    if (!locked) return;
    const profiles = (await db.query(`SELECT p.id,p.assistant_id FROM cc_video_ai_profiles p
      LEFT JOIN cc_widget_revisions r ON r.id=p.revision_id WHERE p.deleted_at IS NULL AND p.assistant_id NOT LIKE 'pending:%'
      AND p.created_at<now()-interval '1 hour' AND (r.state='archived' OR p.status='failed')
      AND NOT EXISTS(SELECT 1 FROM cc_widgets w WHERE w.published_revision_id=p.revision_id)
      AND NOT EXISTS(SELECT 1 FROM cc_video_ai_sessions a JOIN acd_video_sessions v ON v.id=a.video_session_id
        WHERE a.profile_id=p.id AND v.state NOT IN ('ended','failed')) LIMIT 10`)).rows;
    for (const profile of profiles) {
      try { await request(`/ai/assistants/${encodeURIComponent(profile.assistant_id)}`, { method: "DELETE" }); }
      catch (error) { if (error.status !== 404) continue; }
      await db.query("UPDATE cc_video_ai_profiles SET status='retired',deleted_at=now() WHERE id=$1", [profile.id]);
    }
  } finally { try { if (locked) await db.query("SELECT pg_advisory_unlock(814025,2)"); } finally { db.release(); } }
}

// Explicit Studio status check; no source configuration is changed here.
export async function videoProfileStatus(pool, widgetId, {request = widgetAiRequest} = {}) {
  const rows=(await pool.query(`SELECT p.* FROM cc_video_ai_profiles p JOIN cc_widgets w ON w.published_revision_id=p.revision_id
    WHERE w.id=$1 AND p.deleted_at IS NULL`,[widgetId])).rows;
  return Promise.all(rows.map(async p=>{
    try {const source=unwrap(await request(`/ai/assistants/${encodeURIComponent(p.source_assistant_id)}`));return {sourceAssistantId:p.source_assistant_id,name:source.name||p.source_name,status:p.status,sourceChanged:p.source_hash!==profileHash(source)};}
    catch {return {sourceAssistantId:p.source_assistant_id,name:p.source_name,status:'unavailable',sourceChanged:null};}
  }));
}
