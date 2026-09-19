import { channelDefinition } from "./channel-registry.mjs";
import { loadEmailPreviewSettings } from "../email/preview-settings.mjs";
import { emailHtmlText } from "../email/content.mjs";
// Read-only projections. Never import desktop, presence or command handlers here.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function authorizeInteractionRead(db, workItemId, user, { supervisor: supervisorOverride } = {}) {
  if (!user?.id || user.active === false)
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  if (!uuid.test(workItemId || ""))
    throw Object.assign(new Error("Interaction not found"), { status: 404 });
  // Callers pass the permission decision (an elevated grant inside the data
  // scope); the role-name fallback serves legacy callers only.
  const supervisor = typeof supervisorOverride === "boolean"
    ? supervisorOverride
    : (user.roles || []).some((role) => ["supervisor", "admin", "owner"].includes(String(role).toLowerCase()));
  const result = await db.query(
    `SELECT w.id,w.channel,w.direction,w.state,w.conversation_id,w.queue_id,
    CASE WHEN $3::boolean THEN NULL ELSE $2::text END AS read_agent_id,$3::boolean AS can_preview_drafts,w.priority,w.required_skills,w.customer_address,w.cc_address,w.created_at,w.enqueued_at,w.terminal_at,
    q.display_name AS queue_display_name,q.name AS queue_name,c.customer_name,
    a.agent_id,u.first_name,u.last_name,u.username AS agent_username
    FROM acd_work_items w LEFT JOIN cc_queues q ON q.id=w.queue_id
    LEFT JOIN acd_conversations c ON c.id=w.conversation_id
    LEFT JOIN LATERAL (SELECT agent_id FROM acd_segments WHERE work_item_id=w.id AND kind='agent' ORDER BY seq DESC LIMIT 1) a ON true
    LEFT JOIN users u ON u.id=a.agent_id
    WHERE w.id=$1 AND ($3::boolean OR (w.terminal_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM acd_segments s WHERE s.work_item_id=w.id AND s.agent_id=$2)))`,
    [workItemId, String(user.id), supervisor],
  );
  if (!result.rows[0])
    throw Object.assign(new Error("Interaction not found or unavailable"), {
      status: 404,
    });
  return result.rows[0];
}

export async function readConversationPreview(
  db,
  work,
  { before = null, limit = 100, messageIds = [] } = {},
) {
  const definition = channelDefinition(work.channel);
  if (!definition.capabilities.conversation)
    throw Object.assign(
      new Error("This interaction has no messaging conversation"),
      { status: 400 },
    );
  if (before != null && !/^\d+$/.test(String(before)))
    throw Object.assign(new Error("Invalid message cursor"), { status: 400 });
  const email = definition.viewer === "email";
  const sms = work.channel === "sms";
  const whatsapp = work.channel === "whatsapp";
  const page = (
    await db.query(
      "SELECT id,seq::text FROM acd_messages WHERE work_item_id=$1 AND ($2::bigint IS NULL OR seq<$2::bigint) ORDER BY seq DESC LIMIT $3",
      [work.id, before, Math.min(limit, 100) + 1],
    )
  ).rows;
  const hasMore = page.length > limit;
  const pageIds = page.slice(0, limit).map((row) => row.id);
  const ids = [...new Set([...pageIds, ...messageIds])];
  const rows = (
    await db.query(
      `SELECT m.id,m.seq::text,m.work_item_id,m.sender_role,m.sender_id,m.body,m.created_at,
    u.first_name,u.last_name,u.profile_picture_uri ${email ? ",e.envelope,e.html_body,e.status" : ""}
    ${sms ? ",s.status AS sms_status,s.direction AS sms_direction,s.encoding AS sms_encoding,s.parts AS sms_parts,s.error_code AS sms_error_code,s.error_detail AS sms_error_detail,s.occurred_at AS sms_occurred_at,s.media AS sms_media" : ""}
    ${whatsapp ? ",wa.status AS wa_status,wa.direction AS wa_direction,wa.kind AS wa_kind,wa.content AS wa_content,wa.error_code AS wa_error_code,wa.error_detail AS wa_error_detail,wa.occurred_at AS wa_occurred_at" : ""}
    FROM acd_messages m LEFT JOIN users u ON m.sender_role='agent' AND u.id=m.sender_id
    ${email ? "LEFT JOIN cc_email_messages e ON e.message_id=m.id" : ""}
    ${sms ? "LEFT JOIN cc_sms_messages s ON s.message_id=m.id" : ""}
    ${whatsapp ? "LEFT JOIN cc_whatsapp_messages wa ON wa.message_id=m.id" : ""}
    WHERE m.work_item_id=$1 AND m.id=ANY($2::uuid[])
    ORDER BY m.seq`,
      [work.id, ids],
    )
  ).rows;
  const selected = rows;
  const files =
    email || !selected.length
      ? []
      : (
          await db.query(
            `SELECT id,message_id,name,content_type,byte_size
    FROM acd_text_attachments WHERE message_id=ANY($1::uuid[])`,
            [selected.map((m) => m.id)],
          )
        ).rows;
  const deliveries =
    !email || !selected.length
      ? []
      : (
          await db.query(
            `SELECT message_id,kind,CASE WHEN kind='bcc' THEN NULL ELSE address END AS address,status,occurred_at
    FROM cc_email_deliveries WHERE message_id=ANY($1::uuid[]) ORDER BY occurred_at`,
            [selected.map((m) => m.id)],
          )
        ).rows;
  const messages = selected.map((row) => {
    const { bcc: _bcc, attachments = [], ...envelope } = row.envelope || {};
    const { sms_status, sms_direction, sms_encoding, sms_parts, sms_error_code, sms_error_detail, sms_occurred_at, sms_media,
      wa_status, wa_direction, wa_kind, wa_content, wa_error_code, wa_error_detail, wa_occurred_at, ...visible } = row;
    return {
      ...visible,
      ...(sms && sms_status ? { delivery: { status: sms_status, direction: sms_direction, encoding: sms_encoding, parts: sms_parts,
        error_code: sms_error_code, error_detail: sms_error_detail, occurred_at: sms_occurred_at, media: sms_media || [] } } : {}),
      ...(whatsapp && wa_status ? { delivery: { status: wa_status, direction: wa_direction, provider: "whatsapp", kind: wa_kind,
        error_code: wa_error_code, error_detail: wa_error_detail, occurred_at: wa_occurred_at,
        content: { location: wa_content?.location || null, contacts: wa_content?.contacts || null, interactive_reply: wa_content?.interactive_reply || null,
          reaction: wa_content?.reaction || null, template: wa_content?.template || null, media: wa_content?.media ? { kind: wa_content.media.kind, state: wa_content.media.state } : null } } } : {}),
      ...(email ? { envelope, recipient_count: ['to','cc','bcc'].reduce((n,key)=>n+(Array.isArray(row.envelope?.[key])?row.envelope[key].length:0),0) } : {}),
      attachments: email
        ? attachments.map((file, index) => ({
            name: file.filename || file.name || "Attachment",
            content_type: file.content_type,
            byte_size: file.size_bytes,
            content_id: file.content_id,
            url: `/api/contact-center/interactions/${work.id}/conversation/email-attachments/${row.id}/${index}`,
          }))
        : files
            .filter((file) => file.message_id === row.id)
            .map((file) => ({
              ...file,
              url: `/api/contact-center/interactions/${work.id}/conversation/attachments/${file.id}`,
            })),
      deliveries: deliveries
        .filter((d) => d.message_id === row.id)
        .map(({ kind, address, status, occurred_at }) => ({
          kind,
          address,
          status,
          occurred_at,
        })),
    };
  });
  const mailbox = email
    ? (
        await db.query(
          `SELECT t.subject,b.name,b.address FROM cc_email_threads t
    JOIN cc_email_mailboxes b ON b.id=t.mailbox_id WHERE t.conversation_id=$1`,
          [work.conversation_id],
        )
      ).rows[0]
    : null;
  const smsThread = sms
    ? (
        await db.query(
          `SELECT t.customer_address,t.state,t.opted_out_at IS NOT NULL AS opted_out,n.phone_number AS business_number,n.name AS number_name
    FROM cc_sms_threads t JOIN cc_sms_numbers n ON n.id=t.number_id WHERE t.conversation_id=$1`,
          [work.conversation_id],
        )
      ).rows[0] || null
    : null;
  const whatsappThread = whatsapp
    ? (
        await db.query(
          `SELECT t.customer_address,t.customer_name,t.state,t.last_inbound_at,n.phone_number AS business_number,n.name AS number_name
    FROM cc_whatsapp_threads t JOIN cc_whatsapp_numbers n ON n.id=t.number_id WHERE t.conversation_id=$1`,
          [work.conversation_id],
        )
      ).rows[0] || null
    : null;
  const episodes = (
    await db.query(
      `SELECT id,state,created_at,terminal_at FROM acd_work_items
    WHERE conversation_id=$1 AND ($2::text IS NULL OR (terminal_at IS NOT NULL AND EXISTS(SELECT 1 FROM acd_segments s WHERE s.work_item_id=acd_work_items.id AND s.agent_id=$2))) ORDER BY created_at`,
      [work.conversation_id, work.read_agent_id || null],
    )
  ).rows;
  const sla =
    (
      await db.query(
        "SELECT state,at_risk,deadline_at,served_at,policy FROM acd_sla_status WHERE work_item_id=$1 ORDER BY started_at DESC LIMIT 1",
        [work.id],
      )
    ).rows[0] || null;
  const journey = (
    await db.query(
      `SELECT s.id,s.kind,s.started_at,s.ended_at,s.outcome,s.wrapup_code_id,wc.name AS wrapup_code_name,q.name AS queue_name,u.username AS agent_username FROM acd_segments s LEFT JOIN cc_queues q ON q.id=s.queue_id LEFT JOIN users u ON u.id=s.agent_id LEFT JOIN cc_wrapup_codes wc ON wc.id=s.wrapup_code_id WHERE s.work_item_id=$1 ORDER BY s.seq`,
      [work.id],
    )
  ).rows;
  // Only the currently assigned agent's live draft is visible to supervisors.
  // Project explicit fields so BCC and attachment bytes never enter the read API.
  const drafts = email && work.can_preview_drafts && !work.terminal_at && work.state === "active"
    ? (await db.query(`SELECT d.agent_id,d.draft_id,d.version::text,d.updated_at,
        d.content->>'text' AS body,d.content->>'html' AS html_body,
        jsonb_build_object('from',$2::text,'to',d.content->>'to','cc',d.content->>'cc',
          'subject',d.content->>'subject') AS envelope,
        u.first_name,u.last_name,u.username AS agent_username,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name',f->>'filename','content_type',f->>'content_type',
          'byte_size',length(f->>'content')/4*3-CASE WHEN f->>'content' LIKE '%==' THEN 2 WHEN f->>'content' LIKE '%=' THEN 1 ELSE 0 END))
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.content->'attachments')='array'
            THEN d.content->'attachments' ELSE '[]'::jsonb END) f),'[]'::jsonb) AS attachments
      FROM cc_email_drafts d JOIN users u ON u.id=d.agent_id
      WHERE d.work_item_id=$1 AND jsonb_typeof(d.content)='object'
        AND EXISTS(SELECT 1 FROM acd_text_assignments a WHERE a.work_item_id=d.work_item_id
          AND a.agent_id=d.agent_id AND a.state='active') ORDER BY d.updated_at,d.agent_id`,[work.id,mailbox?.address||null])).rows
        .filter(draft => draft.body?.trim() || emailHtmlText(draft.html_body) || /<img\b/i.test(draft.html_body||'') || draft.attachments.length)
        .map(draft => ({...draft,id:`draft:${work.id}:${draft.agent_id}${draft.draft_id==='legacy'?'':`:${draft.draft_id}`}`,sender_role:'agent',status:'draft',
          attachments:draft.attachments.map((file,index)=>({...file,
            url:`/api/contact-center/interactions/${work.id}/conversation/email-drafts/${encodeURIComponent(draft.agent_id)}/attachments/${index}?version=${draft.version}${draft.draft_id==='legacy'?'':`&draftId=${encodeURIComponent(draft.draft_id)}`}`}))}))
    : [];
  const { read_agent_id: _scope, can_preview_drafts: _draftScope, ...visibleWork } = work;
  return {
    work: visibleWork,
    mailbox,
    ...(sms ? { sms: smsThread } : {}),
    ...(whatsapp ? { whatsapp: whatsappThread } : {}),
    ...(email ? { preview: await loadEmailPreviewSettings(db), drafts } : {}),
    messages,
    episodes,
    journey,
    sla,
    hasMore,
    before: page.slice(0, limit).at(-1)?.seq || null,
    readOnly: true,
  };
}

export async function readConversationSnapshot(
  pool,
  { workItemId, user, supervisor, after, before, refreshSnapshot = false },
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const work = await authorizeInteractionRead(db, workItemId, user, { supervisor });
    // The commit-ordered journal is the refresh cursor; message.seq only paginates an episode.
    const latest = (
      await db.query(
        `SELECT COALESCE(MAX(s.seq),0)::text AS cursor FROM acd_stream_events s
      JOIN acd_events e ON e.id=s.event_id WHERE e.work_item_id=$1`,
        [work.id],
      )
    ).rows[0].cursor;
    const firstRetained = (
      await db.query("SELECT MIN(seq)::text AS seq FROM acd_stream_events")
    ).rows[0].seq;
    const reset =
      after == null ||
      BigInt(after) > BigInt(latest) ||
      (firstRetained != null && BigInt(after) < BigInt(firstRetained) - 1n);
    const batch =
      after == null
        ? []
        : (
            await db.query(
              `SELECT s.seq::text,e.payload->>'message_id' AS message_id
      FROM acd_stream_events s JOIN acd_events e ON e.id=s.event_id WHERE e.work_item_id=$1 AND s.seq>$2::bigint
      ORDER BY s.seq LIMIT 200`,
              [work.id, after],
            )
          ).rows;
    const cursor = batch.at(-1)?.seq || latest;
    const changed =
      reset ||
      refreshSnapshot ||
      after == null ||
      String(after) !== cursor ||
      before != null;
    const messageIds = batch
      .map((row) => row.message_id)
      .filter((id) => uuid.test(id || ""));
    const snapshot = changed
      ? await readConversationPreview(db, work, { before, messageIds })
      : null;
    await db.query("COMMIT");
    return { cursor, snapshot, reset };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
