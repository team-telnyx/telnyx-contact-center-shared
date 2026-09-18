import { randomUUID } from "node:crypto";
import { whatsappRequest, whatsappError, whatsappId, resolveWhatsAppCredentials, forgetWhatsAppCredentials } from "./provider.mjs";
import { whatsappWebhookUrl, whatsappWebhookPublicKeys, WHATSAPP_WEBHOOK_PATH } from "./webhook-url.mjs";
import { validateTemplateDefinitionComponents, WHATSAPP_TEMPLATE_CATEGORIES } from "./templates.mjs";
import { WHATSAPP_WABA_WEBHOOK_EVENTS, WHATSAPP_PROFILE_CATEGORIES, normalizeWhatsAppAccount, normalizeWhatsAppPhoneNumber, normalizeWhatsAppSettings, normalizeWhatsAppPhone, isWhatsAppE164 } from "./admin-model.mjs";
import { parseChatCopilotSettings, loadChatCopilotSettings } from "../contact-center/chat-copilot-settings.mjs";

export { WHATSAPP_WEBHOOK_PATH };

const httpsUrl = (value) => { if (!value) return true; try { return new URL(value).protocol === "https:"; } catch { return false; } };
const credentialSummary = (credentials) => ({ source: credentials.source, resolved: credentials.resolved, checkedAt: credentials.checkedAt ? new Date(credentials.checkedAt).toISOString() : null,
  checks: credentials.checks || [], wabaCount: credentials.accounts?.length || 0, error: credentials.error || null });

async function safeCredentials() {
  try { return await resolveWhatsAppCredentials(); }
  catch (error) { return { source: "none", apiKey: "", resolved: false, accounts: [], checks: [], checkedAt: Date.now(), error: error.message }; }
}

// Recommended topology: one Contact Center WhatsApp messaging profile on the
// account that owns the WhatsApp Business Account. Numbers mapped here are
// pointed at that profile, so inbound messages and receipts reach this
// application while other numbers keep their own profile (for example the demo portal).
export async function ensureWhatsAppProfileWebhook(profile, request = whatsappRequest) {
  const url = whatsappWebhookUrl();
  const patch = {};
  if ((profile.webhook_url || null) !== url) patch.webhook_url = url;
  if (profile.webhook_api_version !== "2") patch.webhook_api_version = "2";
  if (!Array.isArray(profile.whitelisted_destinations) || !profile.whitelisted_destinations.length) patch.whitelisted_destinations = ["*"];
  if (profile.enabled === false) patch.enabled = true;
  if (Object.keys(patch).length) return (await request(`/messaging_profiles/${whatsappId(profile.id)}`, { method: "PATCH", body: patch })).data || { ...profile, ...patch };
  return profile;
}

async function listAll(request, path, pageSize = 250) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const result = await request(`${path}${path.includes("?") ? "&" : "?"}page[size]=${pageSize}&page[number]=${page}`);
    rows.push(...(result.data || []));
    const meta = result.meta || {};
    if (!meta.total_pages || page >= meta.total_pages) return rows;
  }
  throw whatsappError("Too many pages to load from Telnyx. Narrow the account inventory.", 502);
}

export async function whatsappAdminOverview(db) {
  const credentials = await safeCredentials();
  const numbers = (await db.query(`SELECT n.*,q.name AS queue_name,p.name AS profile_name,COALESCE(qc.enabled,false) AS queue_whatsapp_enabled,
      (SELECT count(*)::int FROM cc_whatsapp_received r WHERE r.number_id=n.id AND r.processed_at IS NULL) AS backlog,
      (SELECT count(*)::int FROM cc_whatsapp_threads t WHERE t.number_id=n.id) AS threads,
      (SELECT count(*)::int FROM cc_whatsapp_threads t WHERE t.number_id=n.id AND t.last_inbound_at>now()-interval '24 hours') AS open_windows,
      (SELECT max(t.last_inbound_at) FROM cc_whatsapp_threads t WHERE t.number_id=n.id) AS last_inbound_at
    FROM cc_whatsapp_numbers n JOIN cc_queues q ON q.id=n.queue_id LEFT JOIN cc_whatsapp_profiles p ON p.id=n.messaging_profile_id
    LEFT JOIN cc_queue_channels qc ON qc.queue_id=q.id AND qc.channel='whatsapp' ORDER BY n.name,n.phone_number`)).rows;
  const profiles = (await db.query(`SELECT p.*,(SELECT count(*)::int FROM cc_whatsapp_numbers n WHERE n.messaging_profile_id=p.id) AS number_count FROM cc_whatsapp_profiles p ORDER BY p.name`)).rows;
  const accounts = (await db.query("SELECT * FROM cc_whatsapp_accounts ORDER BY connected_at")).rows;
  const queues = (await db.query(`SELECT q.id,q.name,COALESCE(c.enabled,false) AS whatsapp_enabled FROM cc_queues q
    LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='whatsapp' WHERE q.enabled ORDER BY q.name`)).rows;
  const audit = (await db.query(`SELECT a.*,COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),NULLIF(TRIM(u.username),''),'Unknown administrator') AS actor_name
    FROM cc_whatsapp_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 30`)).rows;
  const ingestionFailures = (await db.query(`SELECT e.event_id,e.event_type,e.status,e.attempt_count,e.last_error,e.received_at,e.next_attempt_at,
      COALESCE(e.payload->'from'->>'phone_number',e.payload->>'from') AS from_number,COALESCE(e.payload->'to'->0->>'phone_number',e.payload->>'to') AS to_number,
      left(COALESCE(e.payload->>'text',e.payload->'whatsapp_message'->'text'->>'body',e.payload->'whatsapp_message'->>'type'),80) AS text
    FROM acd_webhook_events e WHERE e.provider='telnyx-whatsapp' AND e.status IN ('dead','retryable_failed','unmatched') ORDER BY e.received_at DESC LIMIT 100`)).rows;
  let webhookUrl = null, webhookError = null;
  try { webhookUrl = whatsappWebhookUrl(); } catch (error) { webhookError = error.message; }
  return { credentials: credentialSummary(credentials), credentialsConfigured: Boolean(credentials.apiKey),
    webhookKeyConfigured: whatsappWebhookPublicKeys().length > 0, backupWebhookKeyConfigured: Boolean(process.env.TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP),
    webhookPath: WHATSAPP_WEBHOOK_PATH, webhookUrl, webhookError, numbers, profiles, accounts, queues, audit, ingestionFailures,
    copilot: await loadChatCopilotSettings(db, "whatsapp") };
}

export async function whatsappAdminResource(db, params, { request = whatsappRequest } = {}) {
  const resource = params.get("resource");
  if (resource === "accounts") {
    const connected = new Set((await db.query("SELECT id FROM cc_whatsapp_accounts")).rows.map((row) => row.id));
    return { data: (await listAll(request, "/whatsapp/business_accounts")).map((account) => ({ ...normalizeWhatsAppAccount(account), connected: connected.has(account.id) })) };
  }
  if (resource === "account") {
    const id = whatsappId(String(params.get("id") || ""));
    const [account, settings, numbers] = await Promise.all([request(`/whatsapp/business_accounts/${id}`), request(`/whatsapp/business_accounts/${id}/settings`), listAll(request, "/whatsapp/phone_numbers")]);
    const normalized = normalizeWhatsAppAccount(account.data || {});
    await db.query("UPDATE cc_whatsapp_accounts SET name=$2,waba_id=$3,snapshot=$4::jsonb,synced_at=now(),last_error=NULL WHERE id=$1",
      [normalized.id, normalized.name, normalized.wabaId, JSON.stringify({ account: normalized, settings: normalizeWhatsAppSettings(settings.data || {}) })]);
    return { account: normalized, settings: normalizeWhatsAppSettings(settings.data || {}),
      phoneNumbers: (numbers || []).map(normalizeWhatsAppPhoneNumber).filter((number) => !normalized.wabaId || !number.wabaId || number.wabaId === normalized.wabaId) };
  }
  if (resource === "phone-numbers") {
    const managed = new Map((await db.query("SELECT id,phone_number,queue_id,name,messaging_profile_id FROM cc_whatsapp_numbers")).rows.map((row) => [row.phone_number, row]));
    const waba = params.get("waba") || "";
    return { data: (await listAll(request, "/whatsapp/phone_numbers")).map((number) => ({ ...normalizeWhatsAppPhoneNumber(number), managed: managed.get(number.phone_number) || null }))
      .filter((number) => !waba || number.wabaId === waba) };
  }
  if (resource === "phone-number") {
    const phone = normalizeWhatsAppPhone(params.get("phone"));
    if (!isWhatsAppE164(phone)) throw whatsappError("Enter a phone number in E.164 format");
    const encoded = whatsappId(phone);
    const [profile, calling, photo] = await Promise.allSettled([request(`/whatsapp/phone_numbers/${encoded}/profile`), request(`/whatsapp/phone_numbers/${encoded}/calling_settings`), request(`/whatsapp/phone_numbers/${encoded}/profile/photo`)]);
    if (profile.status === "rejected") throw profile.reason;
    const managed = (await db.query("SELECT id,name,queue_id,messaging_profile_id,routing_enabled,sending_enabled FROM cc_whatsapp_numbers WHERE phone_number=$1", [phone])).rows[0] || null;
    return { phoneNumber: phone, profile: profile.value?.data || {}, calling: calling.status === "fulfilled" ? calling.value?.data || {} : { error: calling.reason?.message || "Calling settings unavailable" },
      photo: photo.status === "fulfilled" ? photo.value?.data || {} : {}, managed };
  }
  if (resource === "templates") {
    const query = new URLSearchParams();
    for (const key of ["filter[waba_id]", "filter[category]", "filter[status]", "filter[search]"]) if (params.get(key)) query.set(key, params.get(key));
    // Telnyx returns the Meta WABA id under `whatsapp_business_account.id`; expose it as `waba_id` too.
    return { data: (await listAll(request, `/whatsapp/message_templates${query.size ? `?${query}` : ""}`, 100)).map((template) => ({ ...template,
      waba_id: String(template.whatsapp_business_account?.waba_id || template.whatsapp_business_account?.id || template.waba_id || "") })) };
  }
  if (resource === "template") return { data: (await request(`/whatsapp/message_templates/${whatsappId(String(params.get("id") || ""))}`)).data || null };
  if (resource === "profiles") {
    const connected = new Set((await db.query("SELECT id FROM cc_whatsapp_profiles")).rows.map((row) => row.id));
    let expected = null; try { expected = whatsappWebhookUrl(); } catch { /* reported by overview */ }
    return { data: (await listAll(request, "/messaging_profiles")).map((profile) => ({ id: profile.id, name: profile.name, enabled: profile.enabled,
      webhook_url: profile.webhook_url || null, webhook_failover_url: profile.webhook_failover_url || null, webhook_api_version: profile.webhook_api_version || null,
      number_pool: Boolean(profile.number_pool_settings), connected: connected.has(profile.id), webhook_matches: Boolean(expected) && profile.webhook_url === expected, created_at: profile.created_at })) };
  }
  if (resource === "deliveries") return { data: (await db.query(`SELECT s.message_id,s.status,s.direction,s.provider_message_id,s.kind,s.error_code,s.error_detail,s.occurred_at,
      m.created_at,left(m.body,120) AS text,n.phone_number AS business_number,t.customer_address,t.customer_name,u.username AS agent
    FROM cc_whatsapp_messages s JOIN acd_messages m ON m.id=s.message_id JOIN cc_whatsapp_numbers n ON n.id=s.number_id
    LEFT JOIN cc_whatsapp_threads t ON t.conversation_id=m.conversation_id LEFT JOIN users u ON u.id=m.sender_id AND m.sender_role='agent'
    WHERE s.direction='outbound' ORDER BY m.created_at DESC LIMIT 100`)).rows };
  throw whatsappError("Unsupported WhatsApp administration resource");
}

const audit = (db, actor, action, resourceId, details) => db.query("INSERT INTO cc_whatsapp_audit(actor_id,action,resource_id,details) VALUES($1,$2,$3,$4::jsonb)", [actor, action, resourceId, JSON.stringify(details || {})]);

export async function whatsappAdminAction(db, input, actor, { request = whatsappRequest } = {}) {
  const { action } = input; let result, warning, resourceId = input.id || input.profileId || input.accountId || input.phoneNumber || null;
  if (action === "refresh_credentials") {
    forgetWhatsAppCredentials();
    result = credentialSummary(await safeCredentials()); resourceId = result.source;
  } else if (action === "connect_account") {
    const account = normalizeWhatsAppAccount((await request(`/whatsapp/business_accounts/${whatsappId(String(input.accountId || ""))}`)).data || {});
    if (!account.id) throw whatsappError("The WhatsApp Business Account could not be loaded from Telnyx", 502);
    const credentials = await safeCredentials();
    result = (await db.query(`INSERT INTO cc_whatsapp_accounts(id,waba_id,name,credential_source,snapshot,synced_at) VALUES($1,$2,$3,$4,$5::jsonb,now())
      ON CONFLICT(id) DO UPDATE SET waba_id=EXCLUDED.waba_id,name=EXCLUDED.name,credential_source=EXCLUDED.credential_source,snapshot=EXCLUDED.snapshot,synced_at=now(),version=cc_whatsapp_accounts.version+1 RETURNING *`,
    [account.id, account.wabaId, account.name, credentials.source, JSON.stringify({ account })])).rows[0]; resourceId = account.id;
  } else if (action === "disconnect_account") {
    result = { removed: (await db.query("DELETE FROM cc_whatsapp_accounts WHERE id=$1", [input.accountId])).rowCount > 0 };
  } else if (action === "save_account_settings") {
    const settings = input.settings || {};
    const allowed = new Set(WHATSAPP_WABA_WEBHOOK_EVENTS.map((event) => event.value));
    const events = Array.isArray(settings.webhookEvents) ? [...new Set(settings.webhookEvents.map(String))] : [];
    if (events.some((event) => !allowed.has(event))) throw whatsappError("Unsupported WABA webhook event");
    if (!httpsUrl(settings.webhookUrl) || !httpsUrl(settings.webhookFailoverUrl)) throw whatsappError("WABA webhook URLs must use HTTPS");
    if (settings.webhookEnabled && !settings.webhookUrl) throw whatsappError("Webhook URL is required when WABA webhooks are enabled");
    const body = { name: String(settings.name || "").trim().slice(0, 120), timezone: String(settings.timezone || "UTC").slice(0, 64), webhook_url: String(settings.webhookUrl || "").trim(),
      webhook_failover_url: String(settings.webhookFailoverUrl || "").trim(), webhook_enabled: Boolean(settings.webhookEnabled), webhook_events: events };
    result = normalizeWhatsAppSettings((await request(`/whatsapp/business_accounts/${whatsappId(String(input.accountId || ""))}/settings`, { method: "PATCH", body })).data || {});
  } else if (action === "connect_profile") {
    let profile;
    if (input.create) {
      const name = String(input.name || "").trim().slice(0, 120);
      if (!name) throw whatsappError("Enter a name for the messaging profile");
      profile = (await request("/messaging_profiles", { method: "POST", body: { name, whitelisted_destinations: ["*"], webhook_url: whatsappWebhookUrl(), webhook_api_version: "2" } })).data;
    } else profile = (await request(`/messaging_profiles/${whatsappId(String(input.profileId || ""))}`)).data;
    if (!profile?.id) throw whatsappError("The messaging profile could not be loaded from Telnyx", 502);
    try { profile = await ensureWhatsAppProfileWebhook(profile, request); }
    catch (error) { warning = `Profile connected. Webhook setup is incomplete: ${error.message}`; }
    const credentials = await safeCredentials();
    resourceId = profile.id;
    result = (await db.query(`INSERT INTO cc_whatsapp_profiles(id,name,credential_source,webhook_url,webhook_failover_url,webhook_api_version,webhook_verified_at,last_error,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() END,$8,now())
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,credential_source=EXCLUDED.credential_source,webhook_url=EXCLUDED.webhook_url,webhook_failover_url=EXCLUDED.webhook_failover_url,
        webhook_api_version=EXCLUDED.webhook_api_version,webhook_verified_at=COALESCE(EXCLUDED.webhook_verified_at,cc_whatsapp_profiles.webhook_verified_at),
        last_error=EXCLUDED.last_error,version=cc_whatsapp_profiles.version+1,updated_at=now() RETURNING *`,
    [profile.id, profile.name || "", credentials.source, profile.webhook_url || null, profile.webhook_failover_url || null, profile.webhook_api_version || null, !warning, warning || null])).rows[0];
  } else if (action === "disconnect_profile") {
    const used = await db.query("SELECT count(*)::int AS n FROM cc_whatsapp_numbers WHERE messaging_profile_id=$1", [input.profileId]);
    if (used.rows[0].n) throw whatsappError("Remove or reassign the numbers on this profile first", 409);
    result = { removed: (await db.query("DELETE FROM cc_whatsapp_profiles WHERE id=$1", [input.profileId])).rowCount > 0 };
  } else if (action === "save_number") {
    const phone = normalizeWhatsAppPhone(input.phoneNumber);
    if (!isWhatsAppE164(phone)) throw whatsappError("Enter a phone number in E.164 format, for example +14155550123");
    const queue = (await db.query(`SELECT q.id,c.enabled FROM cc_queues q LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='whatsapp' WHERE q.id=$1`, [input.queueId])).rows[0];
    if (!queue) throw whatsappError("Select a queue");
    if (input.routingEnabled && !queue.enabled) throw whatsappError("Enable WhatsApp in the queue Utilization settings first");
    if (!String(input.name || "").trim()) throw whatsappError("Number name is required");
    const profileId = input.profileId ? String(input.profileId) : null;
    if (profileId && !(await db.query("SELECT 1 FROM cc_whatsapp_profiles WHERE id=$1", [profileId])).rowCount) throw whatsappError("Connect the messaging profile first");
    // The number's messaging profile decides where inbound messages go. Pointing
    // it at the Contact Center profile is what routes this number here.
    if (profileId && input.assignProfile !== false) {
      const assigned = (await request(`/whatsapp/phone_numbers/${whatsappId(phone)}/profile`, { method: "PATCH", body: { profile_id: profileId } })).data;
      if (assigned?.profile_id && assigned.profile_id !== profileId) throw whatsappError("Telnyx did not assign the number to the selected messaging profile", 502);
    }
    const values = [String(input.name).trim().slice(0, 120), input.queueId, input.routingEnabled === true, input.sendingEnabled === true, profileId,
      input.phoneNumberId ? String(input.phoneNumberId).slice(0, 80) : null, input.wabaId ? String(input.wabaId).slice(0, 80) : null, input.displayName ? String(input.displayName).slice(0, 120) : null,
      input.qualityRating ? String(input.qualityRating).slice(0, 40) : null, input.providerStatus ? String(input.providerStatus).slice(0, 40) : null];
    if (input.id) {
      const saved = await db.query(`UPDATE cc_whatsapp_numbers SET name=$2,queue_id=$3,routing_enabled=$4,sending_enabled=$5,messaging_profile_id=$6,
        phone_number_id=COALESCE($7,phone_number_id),waba_id=COALESCE($8,waba_id),display_name=COALESCE($9,display_name),quality_rating=COALESCE($10,quality_rating),provider_status=COALESCE($11,provider_status),
        last_error=NULL,version=version+1 WHERE id=$1 AND phone_number=$12 AND version=$13 RETURNING *`, [input.id, ...values, phone, input.version]);
      if (!saved.rowCount) throw whatsappError("Number changed. Refresh and retry.", 409);
      result = saved.rows[0]; resourceId = input.id;
    } else {
      resourceId = randomUUID();
      result = (await db.query(`INSERT INTO cc_whatsapp_numbers(id,name,queue_id,routing_enabled,sending_enabled,messaging_profile_id,phone_number_id,waba_id,display_name,quality_rating,provider_status,phone_number)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(phone_number) DO NOTHING RETURNING *`, [resourceId, ...values, phone])).rows[0];
      if (!result) throw whatsappError("This number is already mapped to a queue", 409);
    }
  } else if (action === "remove_number") {
    const threads = await db.query("SELECT count(*)::int AS n FROM cc_whatsapp_threads WHERE number_id=$1", [input.id]);
    if (threads.rows[0].n) throw whatsappError("This number has conversation history. Pause routing and sending instead of removing it.", 409);
    await db.query("DELETE FROM cc_whatsapp_received WHERE number_id=$1", [input.id]);
    result = { removed: (await db.query("DELETE FROM cc_whatsapp_numbers WHERE id=$1", [input.id])).rowCount > 0 };
  } else if (action === "save_template") {
    const components = input.components;
    const category = String(input.category || "").toUpperCase();
    if (!WHATSAPP_TEMPLATE_CATEGORIES.includes(category)) throw whatsappError("Select a template category");
    const errors = validateTemplateDefinitionComponents(components, category);
    if (errors.length) throw whatsappError(errors.join(" "));
    if (input.id) {
      result = (await request(`/whatsapp/message_templates/${whatsappId(String(input.id))}`, { method: "PATCH", body: { category, components } })).data; resourceId = String(input.id);
    } else {
      const name = String(input.name || "").trim();
      if (!/^[a-z0-9_]{1,512}$/.test(name)) throw whatsappError("Template name may contain lowercase letters, numbers and underscores only");
      if (!input.wabaId || !input.language) throw whatsappError("WhatsApp Business Account and language are required");
      result = (await request("/whatsapp/message_templates", { method: "POST", body: { waba_id: String(input.wabaId), name, category, language: String(input.language), components } })).data;
      resourceId = result?.id || name;
    }
  } else if (action === "delete_template") {
    await request(`/whatsapp/message_templates/${whatsappId(String(input.id || ""))}`, { method: "DELETE" });
    result = { removed: true };
  } else if (["save_phone_profile", "set_calling", "verify_number", "resend_verification", "delete_phone_number"].includes(action)) {
    const phone = normalizeWhatsAppPhone(input.phoneNumber);
    if (!isWhatsAppE164(phone)) throw whatsappError("Enter a phone number in E.164 format");
    const encoded = whatsappId(phone); resourceId = phone;
    if (action === "save_phone_profile") {
      const profile = input.profile || {};
      if (String(profile.about || "").length > 139) throw whatsappError("About may contain at most 139 characters");
      if (String(profile.description || "").length > 512) throw whatsappError("Description may contain at most 512 characters");
      if (profile.website && !/^https?:\/\//i.test(String(profile.website))) throw whatsappError("Website must be a valid HTTP(S) URL");
      if (profile.category && !WHATSAPP_PROFILE_CATEGORIES.includes(profile.category)) throw whatsappError("Unsupported business category");
      const body = { display_name: String(profile.displayName || "").trim(), category: String(profile.category || ""), about: String(profile.about || ""), description: String(profile.description || ""),
        email: String(profile.email || "").trim(), website: String(profile.website || "").trim(), address: String(profile.address || ""), ...(profile.profileId ? { profile_id: String(profile.profileId).trim() } : {}) };
      result = (await request(`/whatsapp/phone_numbers/${encoded}/profile`, { method: "PATCH", body })).data || {};
      await db.query("UPDATE cc_whatsapp_numbers SET display_name=$2 WHERE phone_number=$1", [phone, body.display_name || null]);
    } else if (action === "set_calling") result = (await request(`/whatsapp/phone_numbers/${encoded}/calling_settings`, { method: "PATCH", body: { enabled: Boolean(input.enabled) } })).data || {};
    else if (action === "verify_number") {
      const code = String(input.code || "").trim();
      if (!code) throw whatsappError("Verification code is required");
      await request(`/whatsapp/phone_numbers/${encoded}/verify`, { method: "POST", body: { code } }); result = { verified: true };
    } else if (action === "resend_verification") {
      const method = String(input.verificationMethod || "sms");
      if (!["sms", "voice"].includes(method)) throw whatsappError("Select SMS or voice verification");
      await request(`/whatsapp/phone_numbers/${encoded}/resend_verification`, { method: "POST", body: { verification_method: method } }); result = { resent: true };
    } else {
      if ((await db.query("SELECT 1 FROM cc_whatsapp_numbers WHERE phone_number=$1", [phone])).rowCount) throw whatsappError("Remove the queue mapping for this number first", 409);
      await request(`/whatsapp/phone_numbers/${encoded}`, { method: "DELETE" }); result = { removed: true };
    }
  } else if (action === "add_phone_number") {
    const phone = normalizeWhatsAppPhone(input.phoneNumber);
    if (!isWhatsAppE164(phone) || !String(input.displayName || "").trim()) throw whatsappError("Valid phone number and display name are required");
    if (!["sms", "voice"].includes(input.verificationMethod)) throw whatsappError("Select SMS or voice verification");
    await request(`/whatsapp/business_accounts/${whatsappId(String(input.accountId || ""))}/phone_numbers`, { method: "POST",
      body: { phone_number: phone, display_name: String(input.displayName).trim().slice(0, 120), verification_method: input.verificationMethod, language: String(input.language || "en_US").slice(0, 10) } });
    result = { requested: true }; resourceId = phone;
  } else if (action === "retry_ingestion") {
    const owned = await db.query("SELECT event_id FROM acd_webhook_events WHERE event_id=$1 AND provider='telnyx-whatsapp'", [input.eventId]);
    if (!owned.rowCount) throw whatsappError("WhatsApp processing event not found", 404);
    const { executeAcdOperation } = await import("../acd/operations.mjs");
    result = await executeAcdOperation(db, { actorId: actor, requestId: input.requestId, action: "retry_inbox", targetId: input.eventId, reason: "WhatsApp administrator requested message processing retry" });
    resourceId = input.eventId;
  } else if (action === "save_copilot") {
    const settings = parseChatCopilotSettings(input.settings);
    await db.query(`INSERT INTO app_settings(id,cc_settings) VALUES('default',jsonb_build_object('whatsapp_copilot',$1::jsonb))
      ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}'::jsonb)||EXCLUDED.cc_settings`, [JSON.stringify(settings)]);
    result = settings; resourceId = "whatsapp_copilot";
  } else throw whatsappError("Unsupported WhatsApp administration action");
  await audit(db, actor, action, resourceId, { warning: warning || null });
  return { ok: true, result, ...(warning ? { warning } : {}) };
}

// Business profile photo: JPEG or PNG up to 10 MB, streamed to Telnyx as multipart.
export async function whatsappProfilePhoto(db, { phoneNumber, file = null, remove = false }, actor, { request = whatsappRequest } = {}) {
  const phone = normalizeWhatsAppPhone(phoneNumber);
  if (!isWhatsAppE164(phone)) throw whatsappError("Enter a phone number in E.164 format");
  const encoded = whatsappId(phone);
  if (remove) { await request(`/whatsapp/phone_numbers/${encoded}/profile/photo`, { method: "DELETE" }); await audit(db, actor, "remove_profile_photo", phone, {}); return { ok: true }; }
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) throw whatsappError("Choose a profile photo");
  if (!["image/jpeg", "image/png"].includes(file.type)) throw whatsappError("Profile photo must be JPEG or PNG");
  if (file.size > 10 * 1048576) throw whatsappError("Profile photo may not exceed 10 MB", 413);
  const outbound = new FormData();
  outbound.set("file", file, file.name || "profile.jpg");
  const result = (await request(`/whatsapp/phone_numbers/${encoded}/profile/photo`, { method: "POST", formData: outbound })).data || {};
  await audit(db, actor, "upload_profile_photo", phone, {});
  return { ok: true, result };
}
