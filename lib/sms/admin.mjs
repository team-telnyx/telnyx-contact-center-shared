import { randomUUID } from "node:crypto";
import { smsConfig, smsRequest, smsError, smsId } from "./provider.mjs";
import { normalizeE164 } from "./policy.mjs";
import { normalizeSmsTemplateInput } from "./templates.mjs";
import { resolveWebhookBaseUrl } from "../webhook-base-url.mjs";
import { parseChatCopilotSettings, loadChatCopilotSettings } from "../contact-center/chat-copilot-settings.mjs";
import { messagingSettingsFrom } from "../outbound-dialer/messaging/settings.mjs";

export const SMS_WEBHOOK_PATH = "/api/webhooks/telnyx/sms";

export function smsWebhookUrl() {
  if (!(process.env.TELNYX_WEBHOOK_PUBLIC_KEY || process.env.TELNYX_WEBHOOK_SECRET)) throw smsError("Configure the Telnyx webhook public key (TELNYX_WEBHOOK_PUBLIC_KEY) on the server first", 503);
  const url = new URL(`${resolveWebhookBaseUrl()}${SMS_WEBHOOK_PATH}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw smsError("Configure a public HTTPS application base URL (TELNYX_WEBHOOK_BASE_URL or APP_BASE_URL) before connecting a messaging profile", 503);
  return url.href;
}

// Recommended topology: one Contact Center messaging profile carrying every
// managed number. Routing resolves the queue from the receiving number, so a
// profile per queue adds configuration without adding isolation.
export async function ensureSmsProfileWebhook(profile, request = smsRequest) {
  const url = smsWebhookUrl();
  const current = profile.webhook_url || null;
  const patch = {};
  if (current !== url) patch.webhook_url = url;
  if (profile.webhook_api_version !== "2") patch.webhook_api_version = "2";
  if (!Array.isArray(profile.whitelisted_destinations) || !profile.whitelisted_destinations.length) patch.whitelisted_destinations = ["*"];
  if (profile.enabled === false) patch.enabled = true;
  if (Object.keys(patch).length) return (await request(`/messaging_profiles/${smsId(profile.id)}`, { method: "PATCH", body: patch })).data || { ...profile, ...patch };
  return profile;
}

export async function smsAdminOverview(db) {
  const config = smsConfig();
  const numbers = (await db.query(`SELECT n.*,q.name AS queue_name,p.name AS profile_name,COALESCE(qc.enabled,false) AS queue_sms_enabled,
      (SELECT count(*)::int FROM cc_sms_received r WHERE r.number_id=n.id AND r.processed_at IS NULL) AS backlog,
      (SELECT count(*)::int FROM cc_sms_threads t WHERE t.number_id=n.id) AS threads,
      (SELECT count(*)::int FROM cc_sms_threads t WHERE t.number_id=n.id AND t.opted_out_at IS NOT NULL) AS opted_out,
      (SELECT max(t.last_inbound_at) FROM cc_sms_threads t WHERE t.number_id=n.id) AS last_inbound_at
    FROM cc_sms_numbers n JOIN cc_queues q ON q.id=n.queue_id LEFT JOIN cc_sms_profiles p ON p.id=n.messaging_profile_id
    LEFT JOIN cc_queue_channels qc ON qc.queue_id=q.id AND qc.channel='sms' ORDER BY n.name,n.phone_number`)).rows;
  const profiles = (await db.query(`SELECT p.*,(SELECT count(*)::int FROM cc_sms_numbers n WHERE n.messaging_profile_id=p.id) AS number_count FROM cc_sms_profiles p ORDER BY p.name`)).rows;
  const queues = (await db.query(`SELECT q.id,q.name,COALESCE(c.enabled,false) AS sms_enabled FROM cc_queues q
    LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='sms' WHERE q.enabled ORDER BY q.name`)).rows;
  const audit = (await db.query(`SELECT a.*,COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),NULLIF(TRIM(u.username),''),'Unknown administrator') AS actor_name
    FROM cc_sms_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 30`)).rows;
  const ingestionFailures = (await db.query(`SELECT e.event_id,e.event_type,e.status,e.attempt_count,e.last_error,e.received_at,e.next_attempt_at,
      e.payload->'from'->>'phone_number' AS from_number,e.payload->'to'->0->>'phone_number' AS to_number,left(e.payload->>'text',80) AS text
    FROM acd_webhook_events e WHERE e.provider='telnyx-sms' AND e.status IN ('dead','retryable_failed','unmatched') ORDER BY e.received_at DESC LIMIT 100`)).rows;
  let webhookUrl = null, webhookError = null;
  try { webhookUrl = smsWebhookUrl(); } catch (error) { webhookError = error.message; }
  return { credentialsConfigured: Boolean(config.apiKey), webhookKeyConfigured: Boolean(process.env.TELNYX_WEBHOOK_PUBLIC_KEY || process.env.TELNYX_WEBHOOK_SECRET),
    webhookPath: SMS_WEBHOOK_PATH, webhookUrl, webhookError, numbers, profiles, queues, audit, ingestionFailures,
    footerPolicy: await smsFooterPolicy(db), copilot: await loadChatCopilotSettings(db, "sms") };
}

/**
 * The opt-out footer the campaign runner will actually apply, so the template
 * builder previews the sent message instead of a hard-coded example.
 */
export async function smsFooterPolicy(db) {
  let settings = {};
  try { settings = (await db.query("SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1")).rows[0]?.settings || {}; }
  catch { settings = {}; }
  const sms = messagingSettingsFrom(settings).sms;
  return { required: sms.require_opt_out_footer !== false, text: sms.opt_out_footer_text || "", maxSegments: sms.max_segments_per_message || 10 };
}

/**
 * Campaigns that are ready, running or paused will render this template for
 * messages they have not sent yet, so its content must not change underneath
 * them. Draft and completed campaigns keep their own history and are ignored.
 */
async function assertTemplateNotInUse(db, templateId, verb) {
  const used = await db.query(
    `SELECT count(*)::int AS n FROM outbound_campaigns c
     WHERE c.status IN ('ready','running','paused') AND c.metadata->'messaging'->'template'->'sms'->>'template_id'=$1`,
    [String(templateId || "")],
  );
  if (used.rows[0].n) throw smsError(`This template is used by an active campaign and cannot be ${verb}. Stop the campaign first, or duplicate the template.`, 409);
}

async function listAll(request, path, pageSize = 250) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const result = await request(`${path}${path.includes("?") ? "&" : "?"}page[size]=${pageSize}&page[number]=${page}`);
    rows.push(...(result.data || []));
    const meta = result.meta || {};
    if (!meta.total_pages || page >= meta.total_pages) return rows;
  }
  throw smsError("Too many pages to load from Telnyx. Narrow the account inventory.", 502);
}

export async function smsAdminResource(db, params, { request = smsRequest } = {}) {
  const resource = params.get("resource");
  if (resource === "profiles") {
    const connected = new Set((await db.query("SELECT id FROM cc_sms_profiles")).rows.map(r => r.id));
    let expected = null; try { expected = smsWebhookUrl(); } catch { /* reported by overview */ }
    return { data: (await listAll(request, "/messaging_profiles")).map(profile => ({ id: profile.id, name: profile.name, enabled: profile.enabled,
      webhook_url: profile.webhook_url || null, webhook_failover_url: profile.webhook_failover_url || null, webhook_api_version: profile.webhook_api_version || null,
      number_pool: Boolean(profile.number_pool_settings), whitelisted_destinations: profile.whitelisted_destinations || [],
      connected: connected.has(profile.id), webhook_matches: Boolean(expected) && profile.webhook_url === expected, created_at: profile.created_at })) };
  }
  if (resource === "numbers") {
    const managed = new Map((await db.query("SELECT id,phone_number,queue_id FROM cc_sms_numbers")).rows.map(r => [r.phone_number, r]));
    return { data: (await listAll(request, "/phone_numbers/messaging")).map(number => ({ id: number.id, phone_number: number.phone_number,
      messaging_profile_id: number.messaging_profile_id || null, type: number.type || null, country_code: number.country_code || null,
      sms_capable: Boolean(number.features?.sms), two_way: Boolean(number.features?.sms?.domestic_two_way), international_inbound: Boolean(number.features?.sms?.international_inbound),
      traffic_type: number.traffic_type || null, health: number.health || null, managed: managed.get(number.phone_number) || null })) };
  }
  if (resource === "deliveries") return { data: (await db.query(`SELECT s.message_id,s.status,s.direction,s.provider_message_id,s.encoding,s.parts,s.error_code,s.error_detail,s.occurred_at,
      m.created_at,left(m.body,120) AS text,n.phone_number AS business_number,t.customer_address,u.username AS agent
    FROM cc_sms_messages s JOIN acd_messages m ON m.id=s.message_id JOIN cc_sms_numbers n ON n.id=s.number_id
    LEFT JOIN cc_sms_threads t ON t.conversation_id=m.conversation_id LEFT JOIN users u ON u.id=m.sender_id AND m.sender_role='agent'
    WHERE s.direction='outbound' ORDER BY m.created_at DESC LIMIT 100`)).rows };
  if (resource === "opt-outs") return { data: (await db.query(`SELECT t.conversation_id,t.customer_address,t.opted_out_at,t.last_inbound_at,n.phone_number AS business_number,n.name AS number_name
    FROM cc_sms_threads t JOIN cc_sms_numbers n ON n.id=t.number_id WHERE t.opted_out_at IS NOT NULL ORDER BY t.opted_out_at DESC LIMIT 200`)).rows };
  // Local SMS templates for outbound campaigns (Telnyx has no SMS template store).
  if (resource === "templates") return { data: (await db.query(`SELECT t.*,
      (SELECT count(*)::int FROM outbound_campaigns c WHERE c.status<>'archived' AND c.metadata->'messaging'->'template'->'sms'->>'template_id'=t.id::text) AS campaign_count
    FROM cc_sms_templates t ${params.get("status")==="all"?"":"WHERE t.status='active'"} ORDER BY t.name`)).rows };
  if (resource === "template") {
    const row = (await db.query(`SELECT * FROM cc_sms_templates WHERE id=$1`, [String(params.get("id") || "")])).rows[0];
    if (!row) throw smsError("Template not found", 404);
    return { data: row };
  }
  throw smsError("Unsupported SMS administration resource");
}

export async function smsAdminAction(db, input, actor, { request = smsRequest } = {}) {
  const { action } = input; let result, warning, resourceId = input.id || input.profileId || null;
  if (action === "connect_profile") {
    let profile;
    if (input.create) {
      const name = String(input.name || "").trim().slice(0, 120);
      if (!name) throw smsError("Enter a name for the messaging profile");
      profile = (await request("/messaging_profiles", { method: "POST", body: { name, whitelisted_destinations: ["*"], webhook_url: smsWebhookUrl(), webhook_api_version: "2" } })).data;
    } else profile = (await request(`/messaging_profiles/${smsId(String(input.profileId || ""))}`)).data;
    if (!profile?.id) throw smsError("The messaging profile could not be loaded from Telnyx", 502);
    try { profile = await ensureSmsProfileWebhook(profile, request); }
    catch (error) { warning = `Profile connected. Webhook setup is incomplete: ${error.message}`; }
    resourceId = profile.id;
    result = (await db.query(`INSERT INTO cc_sms_profiles(id,name,webhook_url,webhook_failover_url,webhook_api_version,webhook_verified_at,last_error,updated_at)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() END,$7,now())
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,webhook_url=EXCLUDED.webhook_url,webhook_failover_url=EXCLUDED.webhook_failover_url,
        webhook_api_version=EXCLUDED.webhook_api_version,webhook_verified_at=COALESCE(EXCLUDED.webhook_verified_at,cc_sms_profiles.webhook_verified_at),
        last_error=EXCLUDED.last_error,version=cc_sms_profiles.version+1,updated_at=now() RETURNING *`,
    [profile.id, profile.name || "", profile.webhook_url || null, profile.webhook_failover_url || null, profile.webhook_api_version || null, !warning, warning || null])).rows[0];
  } else if (action === "disconnect_profile") {
    const used = await db.query("SELECT count(*)::int AS n FROM cc_sms_numbers WHERE messaging_profile_id=$1", [input.profileId]);
    if (used.rows[0].n) throw smsError("Remove or reassign the numbers on this profile first", 409);
    result = { removed: (await db.query("DELETE FROM cc_sms_profiles WHERE id=$1", [input.profileId])).rowCount > 0 };
  } else if (action === "save_number") {
    const phone = normalizeE164(input.phoneNumber);
    const queue = (await db.query(`SELECT q.id,c.enabled FROM cc_queues q LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='sms' WHERE q.id=$1`, [input.queueId])).rows[0];
    if (!queue) throw smsError("Select a queue");
    if (input.routingEnabled && !queue.enabled) throw smsError("Enable SMS in the queue Utilization settings first");
    if (!String(input.name || "").trim()) throw smsError("Number name is required");
    const profileId = input.profileId ? String(input.profileId) : null;
    if (profileId && !(await db.query("SELECT 1 FROM cc_sms_profiles WHERE id=$1", [profileId])).rowCount) throw smsError("Connect the messaging profile first");
    let providerNumberId = input.providerNumberId ? String(input.providerNumberId) : null;
    if (profileId && providerNumberId && input.assignProfile !== false) {
      const assigned = (await request(`/phone_numbers/${smsId(providerNumberId)}/messaging`, { method: "PATCH", body: { messaging_profile_id: profileId } })).data;
      if (assigned?.messaging_profile_id && assigned.messaging_profile_id !== profileId) throw smsError("Telnyx did not assign the number to the selected messaging profile", 502);
    }
    const values = [String(input.name).trim().slice(0, 120), input.queueId, input.routingEnabled === true, input.sendingEnabled === true, profileId, providerNumberId,
      input.countryCode ? String(input.countryCode).slice(0, 2).toUpperCase() : null, input.numberType ? String(input.numberType).slice(0, 20) : null];
    if (input.id) {
      const saved = await db.query(`UPDATE cc_sms_numbers SET name=$2,queue_id=$3,routing_enabled=$4,sending_enabled=$5,messaging_profile_id=$6,
        provider_number_id=COALESCE($7,provider_number_id),country_code=COALESCE($8,country_code),number_type=COALESCE($9,number_type),last_error=NULL,version=version+1
        WHERE id=$1 AND phone_number=$10 AND version=$11 RETURNING *`, [input.id, ...values, phone, input.version]);
      if (!saved.rowCount) throw smsError("Number changed. Refresh and retry.", 409);
      result = saved.rows[0]; resourceId = input.id;
    } else {
      resourceId = randomUUID();
      result = (await db.query(`INSERT INTO cc_sms_numbers(id,name,queue_id,routing_enabled,sending_enabled,messaging_profile_id,provider_number_id,country_code,number_type,phone_number)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(phone_number) DO NOTHING RETURNING *`, [resourceId, ...values, phone])).rows[0];
      if (!result) throw smsError("This number is already mapped to a queue", 409);
    }
  } else if (action === "remove_number") {
    const threads = await db.query("SELECT count(*)::int AS n FROM cc_sms_threads WHERE number_id=$1", [input.id]);
    if (threads.rows[0].n) throw smsError("This number has conversation history. Pause routing and sending instead of removing it.", 409);
    await db.query("DELETE FROM cc_sms_received WHERE number_id=$1", [input.id]);
    result = { removed: (await db.query("DELETE FROM cc_sms_numbers WHERE id=$1", [input.id])).rowCount > 0 };
  } else if (action === "retry_ingestion") {
    const owned = await db.query("SELECT event_id FROM acd_webhook_events WHERE event_id=$1 AND provider='telnyx-sms'", [input.eventId]);
    if (!owned.rowCount) throw smsError("SMS processing event not found", 404);
    const { executeAcdOperation } = await import("../acd/operations.mjs");
    result = await executeAcdOperation(db, { actorId: actor, requestId: input.requestId, action: "retry_inbox", targetId: input.eventId, reason: "SMS administrator requested message processing retry" });
    resourceId = input.eventId;
  } else if (action === "save_template") {
    const template = normalizeSmsTemplateInput(input);
    if (input.id) {
      // A running campaign renders this template for every message it claims, so
      // an edit would take effect mid-flight on content nobody validated. The
      // same guard already covers archiving and deletion.
      await assertTemplateNotInUse(db, input.id, "edited");
      const saved = await db.query(`UPDATE cc_sms_templates SET name=$2,category=$3,language=$4,body=$5,variables=$6::jsonb,sample_values=$7::jsonb,footer_mode=$8,footer_text=$9,status=$10,
        updated_by=$11,version=version+1,updated_at=now() WHERE id=$1 AND ($12::bigint IS NULL OR version=$12) RETURNING *`,
      [input.id, template.name, template.category, template.language, template.body, JSON.stringify(template.variables), JSON.stringify(template.sample_values), template.footer_mode, template.footer_text, template.status, actor, input.version ?? null]);
      if (!saved.rowCount) throw smsError("Template changed. Refresh and retry.", 409);
      result = saved.rows[0]; resourceId = input.id;
    } else {
      resourceId = randomUUID();
      const created = await db.query(`INSERT INTO cc_sms_templates(id,name,category,language,body,variables,sample_values,footer_mode,footer_text,status,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$11) ON CONFLICT(name) DO NOTHING RETURNING *`,
      [resourceId, template.name, template.category, template.language, template.body, JSON.stringify(template.variables), JSON.stringify(template.sample_values), template.footer_mode, template.footer_text, template.status, actor]);
      if (!created.rows[0]) throw smsError("A template with this name already exists", 409);
      result = created.rows[0];
    }
  } else if (action === "archive_template" || action === "delete_template") {
    await assertTemplateNotInUse(db, input.id, action === "delete_template" ? "deleted" : "archived");
    if (action === "delete_template") result = { removed: (await db.query("DELETE FROM cc_sms_templates WHERE id=$1", [input.id])).rowCount > 0 };
    else result = (await db.query("UPDATE cc_sms_templates SET status='archived',updated_by=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [input.id, actor])).rows[0] || null;
    resourceId = input.id;
  } else if (action === "save_copilot") {
    const settings = parseChatCopilotSettings(input.settings);
    await db.query(`INSERT INTO app_settings(id,cc_settings) VALUES('default',jsonb_build_object('sms_copilot',$1::jsonb))
      ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}'::jsonb)||EXCLUDED.cc_settings`, [JSON.stringify(settings)]);
    result = settings; resourceId = "sms_copilot";
  } else throw smsError("Unsupported SMS administration action");
  await db.query("INSERT INTO cc_sms_audit(actor_id,action,resource_id,details) VALUES($1,$2,$3,$4::jsonb)", [actor, action, resourceId, JSON.stringify({ warning: warning || null })]);
  return { ok: true, result, ...(warning ? { warning } : {}) };
}
