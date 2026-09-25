import { randomUUID, createHash } from "node:crypto";
import { appendEvent } from "../acd/events.mjs";
import { defineSaga, startSaga } from "../acd/saga-engine.mjs";
import { actOnTextWork, appendTextMessage } from "../acd/text-lifecycle.mjs";
import { finishUpload } from "../widgets/attachments.js";
import { withStreamedChatMessage } from "../widgets/multipart-upload.js";
import { normalizeAttachmentMimeType } from "../widgets/attachment-types.mjs";
import { whatsappError, whatsappProvider } from "./provider.mjs";
import { whatsappWebhookUrlOrNull } from "./webhook-url.mjs";
import { createWhatsAppMediaUrl, toWhatsAppSticker, toWhatsAppImage, validateWhatsAppMediaBytes } from "./media.mjs";
import { buildWhatsAppOutbound, buildWhatsAppTextMessage, buildWhatsAppMediaMessage, buildWhatsAppTemplateMessage, describeTemplateSend,
  buildWhatsAppLocationMessage, normalizeWhatsAppLocation, buildWhatsAppContactsMessage, normalizeWhatsAppDeviceContacts, whatsappContactCard, summarizeWhatsAppContacts, buildWhatsAppReactionMessage, describeWhatsAppContent,
  validateOutboundWhatsAppText, whatsappConversationWindow, whatsappMediaKind, validateWhatsAppMedia, utf8Bytes,
  WHATSAPP_MAX_CAPTION_BYTES, WHATSAPP_MAX_CONTACTS, WHATSAPP_MAX_FILES, WHATSAPP_MEDIA_RULES, WHATSAPP_OUTBOUND_MIME_TYPES } from "./policy.mjs";
import { templateVariableFields, templateRuntimeComponents, renderTemplateText } from "./templates.mjs";

const MAX_UPLOAD_BYTES = 100 * 1048576;

async function markSend(db, ctx, status) {
  const failure = (await db.query(`SELECT response,http_status FROM acd_commands WHERE saga_id=$1 AND status IN ('failed','ambiguous')
    ORDER BY created_at DESC LIMIT 1`, [ctx.saga.id])).rows[0];
  await db.query(`UPDATE cc_whatsapp_messages SET status=$2,occurred_at=now(),error_code=COALESCE($3,error_code),error_detail=COALESCE($4,error_detail),next_delivery_sync_at=NULL WHERE message_id=$1`,
    [ctx.data.messageId, status, failure?.response?.code ? String(failure.response.code) : null,
      failure?.response?.error ? String(failure.response.error).slice(0, 300) : null]);
  await appendEvent(db, { workItemId: ctx.workItem.id, type: "message_send_updated", actor: "whatsapp", payload: { message_id: ctx.data.messageId, status } });
}

// Durable WhatsApp send. The provider call happens outside the transaction;
// the journaled command is never replayed after an uncertain outcome because
// POST /v2/messages/whatsapp has no idempotency key (see provider.mjs).
defineSaga("whatsapp_send", {
  initialStep: "send",
  steps: {
    send: {
      async guard(db, ctx) {
        const allowed = await db.query(`SELECT 1 FROM acd_text_assignments a
          JOIN cc_whatsapp_threads t ON t.conversation_id=$3 JOIN cc_whatsapp_numbers n ON n.id=t.number_id AND n.sending_enabled
          WHERE a.work_item_id=$1 AND a.agent_id=$2 AND a.state='active'`,
        [ctx.workItem.id, ctx.data.agentId, ctx.workItem.conversation_id]);
        return allowed.rowCount ? null : "rejected";
      },
      cmd: ctx => ({ operation: "whatsapp_send", endpoint: "/messages/whatsapp", request: ctx.data.payload }),
      // dedupeWindowMs -1: never resend a command whose outcome was lost.
      dedupeWindowMs: -1, deadlineMs: 5 * 60 * 1000, onDeadline: "uncertain", onFailure: "rejected", on: { accepted: "succeeded" },
      async onAccepted(db, { saga, response }) {
        const data = response.data || {};
        await db.query(`UPDATE cc_whatsapp_messages SET provider_message_id=$2,status='accepted',occurred_at=now(),next_delivery_sync_at=now()+interval '2 minutes' WHERE message_id=$1`,
          [saga.data.messageId, String(data.id)]);
        await db.query(`UPDATE cc_whatsapp_threads SET last_outbound_at=now() WHERE conversation_id=(SELECT conversation_id FROM acd_messages WHERE id=$1)`, [saga.data.messageId]);
        await appendEvent(db, { workItemId: saga.work_item_id, type: "message_send_updated", actor: "whatsapp",
          payload: { message_id: saga.data.messageId, status: "accepted", provider_message_id: String(data.id) } });
      },
    },
    rejected: { run: async (db, ctx) => { await markSend(db, ctx, "failed"); return "failed"; } },
    uncertain: { run: async (db, ctx) => { await markSend(db, ctx, "ambiguous"); return "failed"; } },
  },
});

async function journalOutbound(tx, { work, thread, agentId, clientId, body, kind, message, attachment = null, content = {} }) {
  const row = await appendTextMessage(tx, { work, senderRole: "agent", senderId: agentId, clientId, body, allowEmpty: true });
  if (attachment) {
    await tx.query(`INSERT INTO acd_text_attachments(id,message_id,conversation_id,name,content_type,bytes,byte_size,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [attachment.id, row.id, work.conversation_id, attachment.name, attachment.content_type, attachment.bytes, attachment.byte_size, attachment.content_hash]);
  }
  const payload = buildWhatsAppOutbound({ from: thread.phone_number, to: thread.customer_address, message, webhookUrl: whatsappWebhookUrlOrNull(),
    messagingProfileId: thread.messaging_profile_id });
  const started = await startSaga(tx, { type: "whatsapp_send", workItemId: work.id, conflictKey: `whatsapp:${row.id}`,
    data: { messageId: row.id, agentId, payload }, actor: agentId });
  await tx.query(`INSERT INTO cc_whatsapp_messages(message_id,number_id,direction,status,kind,content,saga_id) VALUES($1,$2,'outbound','queued',$3,$4::jsonb,$5)`,
    [row.id, thread.number_id, kind, JSON.stringify({ ...content, whatsapp_message: message, attachment_id: attachment?.id || null }), started.sagaId]);
  return { message: { ...row, delivery: { status: "queued", direction: "outbound", kind, provider: "whatsapp" } }, sagaId: started.sagaId };
}

// `sendHandler` for actOnTextWork: runs inside the command transaction after
// ownership, version and replay checks. Text, media (one provider message per
// file, the first carrying the caption) and templates are all journaled here.
export async function sendAgentWhatsAppInTransaction(tx, { work, agentId, commandId, body, data = {}, attachments = [] }) {
  const thread = (await tx.query(`SELECT t.*,n.phone_number,n.sending_enabled,n.messaging_profile_id FROM cc_whatsapp_threads t JOIN cc_whatsapp_numbers n ON n.id=t.number_id
    WHERE t.conversation_id=$1 FOR UPDATE OF t`, [work.conversation_id])).rows[0];
  if (!thread) throw whatsappError("This conversation has no WhatsApp thread", 409);
  if (!thread.sending_enabled) throw whatsappError("Sending is paused for this number. Ask an administrator to allow agent replies.", 409);
  // The number's messaging profile is the sending profile as well as the inbound
  // one; a WhatsApp-only number cannot send without it.
  if (!thread.messaging_profile_id) throw whatsappError("This number is not connected to a Contact Center messaging profile. Ask an administrator to map it under Admin → WhatsApp → Numbers.", 409);
  const window = whatsappConversationWindow(thread.last_inbound_at);
  const outbound = [];
  if (data.template) {
    const template = data.template;
    if (!template.id && !(template.name && template.language)) throw whatsappError("Select an approved template");
    const message = buildWhatsAppTemplateMessage({ templateId: template.id, name: template.name, language: template.language, components: template.components || [] });
    outbound.push({ body: template.text || describeTemplateSend({ name: template.name, language: template.language, components: template.components || [] }), kind: "template", message,
      content: { template: { id: template.id || null, name: template.name || null, language: template.language || null } } });
  } else if (data.location) {
    if (!window.open) throw whatsappError("The 24-hour customer service window is closed. Send an approved template to reopen the conversation.", 409);
    const location = normalizeWhatsAppLocation(data.location);
    outbound.push({ body: describeWhatsAppContent({ kind: "location", text: "", location }), kind: "location", message: buildWhatsAppLocationMessage(location), content: { location } });
  } else if (data.contactCards !== undefined) {
    if (!window.open) throw whatsappError("The 24-hour customer service window is closed. Send an approved template to reopen the conversation.", 409);
    const cards = normalizeWhatsAppDeviceContacts(data.contactCards);
    const contacts = summarizeWhatsAppContacts(cards);
    outbound.push({ body: describeWhatsAppContent({ kind: "contacts", text: "", contacts }), kind: "contacts",
      message: buildWhatsAppContactsMessage(cards), content: { contacts } });
  } else if (Array.isArray(data.contactIds) && data.contactIds.length) {
    if (!window.open) throw whatsappError("The 24-hour customer service window is closed. Send an approved template to reopen the conversation.", 409);
    const ids = [...new Set(data.contactIds.map((id) => String(id || "").trim()).filter(Boolean))];
    if (ids.length > WHATSAPP_MAX_CONTACTS) throw whatsappError(`Send at most ${WHATSAPP_MAX_CONTACTS} contacts per message`);
    const rows = (await tx.query("SELECT * FROM contacts WHERE id = ANY($1::text[])", [ids])).rows.filter((row) => !row.deleted_at);
    if (rows.length !== ids.length) throw whatsappError("Some of the selected contacts no longer exist", 404);
    const cards = ids.map((id) => whatsappContactCard(rows.find((row) => row.id === id)));
    const contacts = summarizeWhatsAppContacts(cards);
    outbound.push({ body: describeWhatsAppContent({ kind: "contacts", text: "", contacts }), kind: "contacts", message: buildWhatsAppContactsMessage(cards), content: { contacts } });
  } else if (data.reaction) {
    if (!window.open) throw whatsappError("The 24-hour customer service window is closed. Reactions need a message from the customer within the last 24 hours.", 409);
    const targetId = String(data.reaction.messageId || "");
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw whatsappError("Choose the message to react to");
    // Telnyx addresses the customer's message by its own message id.
    const target = (await tx.query(`SELECT m.message_id,m.direction,m.provider_message_id FROM cc_whatsapp_messages m JOIN acd_messages a ON a.id=m.message_id
      WHERE m.message_id=$1 AND a.conversation_id=$2`, [targetId, work.conversation_id])).rows[0];
    if (!target) throw whatsappError("Choose a message from this conversation to react to", 404);
    if (target.direction !== "inbound") throw whatsappError("You can react to the customer's messages only");
    if (!target.provider_message_id) throw whatsappError("This message cannot receive a reaction");
    const message = buildWhatsAppReactionMessage({ messageId: target.provider_message_id, emoji: data.reaction.emoji });
    outbound.push({ body: message.reaction.emoji ? `Reacted ${message.reaction.emoji}` : "Removed reaction", kind: "reaction", message,
      content: { reaction: { message_id: target.provider_message_id, emoji: message.reaction.emoji, target_message_id: target.message_id } } });
  } else {
    if (!window.open) throw whatsappError("The 24-hour customer service window is closed. Send an approved template to reopen the conversation.", 409);
    if (attachments.length > WHATSAPP_MAX_FILES) throw whatsappError(`Attach at most ${WHATSAPP_MAX_FILES} files per message`);
    const text = validateOutboundWhatsAppText(body, { allowEmpty: attachments.length > 0 });
    if (!attachments.length) outbound.push({ body: text, kind: "text", message: buildWhatsAppTextMessage(text) });
    else {
      let caption = text;
      const firstRule = WHATSAPP_MEDIA_RULES[attachments[0].kind];
      if (caption && (!firstRule?.caption || utf8Bytes(caption) > WHATSAPP_MAX_CAPTION_BYTES)) { outbound.push({ body: caption, kind: "text", message: buildWhatsAppTextMessage(caption) }); caption = ""; }
      attachments.forEach((file, index) => {
        validateWhatsAppMedia({ contentType: file.content_type, byteSize: file.byte_size, name: file.name }, file.kind);
        const attachment = { ...file, id: randomUUID() };
        const fileCaption = index === 0 ? caption : "";
        outbound.push({ body: fileCaption || file.name, kind: file.kind, attachment,
          message: buildWhatsAppMediaMessage({ kind: file.kind, link: createWhatsAppMediaUrl(attachment.id), caption: fileCaption, filename: file.name }) });
      });
    }
  }
  const results = [];
  for (const [index, item] of outbound.entries()) {
    results.push(await journalOutbound(tx, { work, thread, agentId, clientId: outbound.length === 1 ? commandId : `${commandId}:${index}`,
      body: item.body, kind: item.kind, message: item.message, attachment: item.attachment || null, content: item.content || {} }));
  }
  return { message: results[0].message, messages: results.map((r) => r.message), sagaId: results[0].sagaId, sagaIds: results.map((r) => r.sagaId), status: "queued" };
}

export const whatsappSendOptions = ({ provider = whatsappProvider() } = {}) => ({ sendHandler: sendAgentWhatsAppInTransaction, sendProvider: provider });

// Admission for agent uploads: the work item must be a WhatsApp conversation
// actively assigned to this agent. Reuses the shared upload lease table.
async function admitWhatsAppUpload(pool, { workItemId, agentId }) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const work = (await tx.query("SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel='whatsapp' FOR UPDATE", [workItemId])).rows[0];
    if (!work) throw whatsappError("Conversation not found", 404);
    const owns = await tx.query("SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'", [work.id, agentId]);
    if (!owns.rowCount) throw whatsappError("Accept the conversation before sending a file", 403);
    await tx.query(`DELETE FROM cc_attachment_uploads WHERE conversation_id=$1 AND created_at<now()-interval '1 minute' AND (finished_at IS NOT NULL OR expires_at<=now())`, [work.conversation_id]);
    const count = (await tx.query(`SELECT count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS recent,
      count(*) FILTER(WHERE finished_at IS NULL AND expires_at>now())::int AS active FROM cc_attachment_uploads WHERE conversation_id=$1`, [work.conversation_id])).rows[0];
    if (count.recent >= 10 || count.active >= 2) throw whatsappError("Please wait before uploading another attachment", 429);
    const id = randomUUID();
    await tx.query("INSERT INTO cc_attachment_uploads(id,conversation_id,expires_at) VALUES($1,$2,now()+interval '2 minutes')", [id, work.conversation_id]);
    await tx.query("COMMIT");
    return { id, work };
  } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
}

// Multipart agent send: files are streamed to disk, validated against the
// WhatsApp media rules, transcoded when necessary (sticker, GIF/WebP pictures)
// and journaled through the same command path as a text reply.
export async function receiveAgentWhatsAppMessage(pool, { request, workItemId, agentId, draftScope="legacy" }, options = {}) {
  const admission = await admitWhatsAppUpload(pool, { workItemId, agentId });
  try {
    return await withStreamedChatMessage(request, { maximumBytes: MAX_UPLOAD_BYTES, mimeTypes: WHATSAPP_OUTBOUND_MIME_TYPES, maximumFiles: WHATSAPP_MAX_FILES, maximumTotalBytes: MAX_UPLOAD_BYTES }, async ({ files, metadata }) => {
      let message; try { message = JSON.parse(metadata); } catch { throw whatsappError("Invalid message metadata"); }
      if (!message || typeof message.body !== "string" || message.body.length > 20000 || typeof message.commandId !== "string" || !message.commandId || message.commandId.length > 100
        || !/^\d+$/.test(String(message.expectedVersion)) || !/^\d+$/.test(String(message.draftVersion))) throw whatsappError("Message, command ID and draft versions are required");
      const kinds = Array.isArray(message.mediaKinds) ? message.mediaKinds : [];
      const attachments = [];
      for (const [index, file] of files.entries()) {
        let bytes = Buffer.from(await file.arrayBuffer());
        let type = normalizeAttachmentMimeType(file.type, file.name);
        validateWhatsAppMediaBytes(bytes, type);
        let name = String(file.name || "attachment").replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 240);
        const kind = whatsappMediaKind(type, name, kinds[index]);
        if (!kind) throw whatsappError(`${name} cannot be sent on WhatsApp`);
        if (kind === "sticker" && type !== "image/webp") { bytes = await toWhatsAppSticker(bytes); type = "image/webp"; name = name.replace(/\.[^.]+$/, "") + ".webp"; }
        else if (kind === "sticker" && bytes.length > WHATSAPP_MEDIA_RULES.sticker.staticMaxBytes) { bytes = await toWhatsAppSticker(bytes); }
        else if (kind === "image" && ["image/webp", "image/gif"].includes(type)) { bytes = await toWhatsAppImage(bytes); type = "image/jpeg"; name = name.replace(/\.[^.]+$/, "") + ".jpg"; }
        validateWhatsAppMedia({ contentType: type, byteSize: bytes.length, name }, kind);
        attachments.push({ name, content_type: type, bytes, byte_size: bytes.length, content_hash: createHash("sha256").update(bytes).digest("hex"), kind });
      }
      return actOnTextWork(pool, { workItemId, agentId, action: "send", channel: "whatsapp", commandId: message.commandId, expectedVersion: message.expectedVersion,
        draftVersion: message.draftVersion, draftScope, body: message.body, mediaKinds: attachments.map((file) => file.kind) }, { attachments, ...whatsappSendOptions(options) });
    });
  } finally { await finishUpload(pool, admission.id); }
}

// Resolves an approved template (loaded by the caller from Telnyx) plus the
// agent's variable values into the components journaled with the send.
export function prepareWhatsAppTemplateSend(template, values = {}) {
  if (!template?.id) throw whatsappError("Select an approved template");
  if (String(template.status || "").toUpperCase() !== "APPROVED") throw whatsappError("Only templates approved by Meta can be sent", 409);
  const fields = templateVariableFields(template);
  for (const field of fields) if (!String(values?.[field.key] ?? "").trim()) throw whatsappError(`Fill in ${field.label} before sending the template`);
  return { id: template.id, name: template.name, language: template.language, components: templateRuntimeComponents(fields, values), text: renderTemplateText(template, values) };
}
