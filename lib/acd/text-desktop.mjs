import { readUtilization } from "./utilization.mjs";
import { NATIVE_LIFECYCLE_CHANNELS } from "./channel-registry.mjs";
import { whatsappConversationWindow, WHATSAPP_MAX_FILES, WHATSAPP_MEDIA_RULES, WHATSAPP_OUTBOUND_MIME_TYPES } from "../whatsapp/policy.mjs";
import { foldWhatsAppAnnotations } from "../whatsapp/annotations.mjs";

export async function readTextInteractions(db,agentId){
  const rows=(await db.query(`SELECT w.*,c.customer_name,q.name AS queue_name,o.id AS offer_id,o.deadline_at AS offer_deadline,
    a.state AS assignment_state,a.wrapup_deadline_at
    FROM acd_work_items w JOIN acd_conversations c ON c.id=w.conversation_id LEFT JOIN cc_queues q ON q.id=w.queue_id
    LEFT JOIN acd_offers o ON o.work_item_id=w.id AND o.agent_id=$1 AND o.state IN ('created','ringing')
    LEFT JOIN acd_text_assignments a ON a.work_item_id=w.id AND a.agent_id=$1 AND a.state<>'completed'
      AND NOT EXISTS(SELECT 1 FROM acd_segments s WHERE s.id=a.segment_id AND s.outcome='transferred')
    WHERE w.channel = ANY($2::text[]) AND (o.id IS NOT NULL OR a.reservation_id IS NOT NULL)
    ORDER BY (o.id IS NOT NULL) DESC,w.created_at`,[agentId,NATIVE_LIFECYCLE_CHANNELS])).rows;
  return {interactions:rows.map(row=>({...row,interaction_type:row.channel,channel:row.channel,from_name:row.customer_name,
    from_number:row.customer_name,core_state:row.state,state:row.offer_id?"ringing":row.assignment_state==="wrapup"?"wrapup":"active"})),
    utilization:await readUtilization(db,"agent",agentId)};
}

export async function readTextDetail(db,{workItemId,agentId,channel="chat"}){
  const work=(await db.query(`SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel=$3 AND
    (EXISTS(SELECT 1 FROM acd_offers o WHERE o.work_item_id=w.id AND o.agent_id=$2 AND o.state IN ('created','ringing','accepted'))
      OR EXISTS(SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
        WHERE a.work_item_id=w.id AND a.agent_id=$2 AND ((a.state IN ('active','wrapup') AND s.outcome IS DISTINCT FROM 'transferred') OR w.terminal_at IS NOT NULL)))`,[workItemId,agentId,channel])).rows[0];
  if(!work)throw Object.assign(new Error("Conversation not found or not assigned to you"),{status:403});
  const messages=(await db.query(`SELECT m.*,u.first_name,u.last_name,u.profile_picture_uri FROM acd_messages m LEFT JOIN users u ON m.sender_role='agent' AND u.id=m.sender_id
    WHERE m.conversation_id=$1 ORDER BY m.seq`,[work.conversation_id])).rows;
  const files=(await db.query("SELECT id,message_id,name,content_type,byte_size FROM acd_text_attachments WHERE conversation_id=$1",[work.conversation_id])).rows;
  for(const message of messages)message.attachments=files.filter(file=>file.message_id===message.id).map(file=>({...file,url:`/api/contact-center/${channel}/${workItemId}/attachments/${file.id}`}));
  const sms=channel==="sms"?await readSmsThreadDetail(db,work,messages):null;
  const whatsapp=channel==="whatsapp"?await readWhatsAppThreadDetail(db,work,messages):null;
  const draft=(await db.query("SELECT body,version FROM acd_text_drafts WHERE work_item_id=$1 AND agent_id=$2",[workItemId,agentId])).rows[0]||{body:"",version:"0"};
  const customer=(await db.query(`SELECT c.customer_name,s.typing_until>now() AS typing FROM acd_conversations c
    LEFT JOIN cc_widget_sessions s ON s.conversation_id=c.id WHERE c.id=$1`,[work.conversation_id])).rows[0];
  const agent=(await db.query("SELECT first_name,last_name,profile_picture_uri FROM users WHERE id=$1",[agentId])).rows[0];
  const codes=(await db.query(`SELECT id,name FROM cc_wrapup_codes c WHERE is_active=true AND
    (NOT EXISTS(SELECT 1 FROM cc_queue_wrapup_codes WHERE queue_id=$1)
     OR EXISTS(SELECT 1 FROM cc_queue_wrapup_codes WHERE queue_id=$1 AND wrapup_code_id=c.id)) ORDER BY name`,[work.queue_id])).rows;
  const widget=(await db.query(`SELECT r.config FROM cc_widget_sessions s JOIN cc_widget_revisions r ON r.id=s.revision_id WHERE s.conversation_id=$1`,[work.conversation_id])).rows[0];
  return {work,messages,draft,customerName:customer?.customer_name||(sms?sms.customer_address:whatsapp?whatsapp.customer_name||whatsapp.customer_address:"Website visitor"),agent,customerTyping:customer?.typing===true,wrapupCodes:codes,
    attachmentPolicy:widget?.config?.features?.attachmentsAfterHandoff?widget.config.features.attachmentPolicy:null,...(sms?{sms}:{}),...(whatsapp?{whatsapp}:{})};
}

// WhatsApp enrichment: thread identity, the 24-hour customer service window,
// the media policy for the composer and per-message provider state.
async function readWhatsAppThreadDetail(db,work,messages){
  const thread=(await db.query(`SELECT t.customer_address,t.customer_name,t.state AS thread_state,t.last_inbound_at,t.last_outbound_at,n.id AS number_id,n.phone_number AS business_number,n.name AS number_name,n.display_name,n.sending_enabled
    FROM cc_whatsapp_threads t JOIN cc_whatsapp_numbers n ON n.id=t.number_id WHERE t.conversation_id=$1`,[work.conversation_id])).rows[0];
  const rows=messages.length?(await db.query(`SELECT message_id,direction,status,provider_message_id,kind,content,error_code,error_detail,occurred_at
    FROM cc_whatsapp_messages WHERE message_id=ANY($1::uuid[])`,[messages.map(m=>m.id)])).rows:[];
  for(const message of messages){
    const row=rows.find(r=>r.message_id===message.id);
    if(row){const content=row.content||{};message.delivery={status:row.status,direction:row.direction,provider:"whatsapp",kind:row.kind,provider_message_id:row.provider_message_id,error_code:row.error_code,error_detail:row.error_detail,occurred_at:row.occurred_at,
      content:{location:content.location||null,contacts:content.contacts||null,interactive_reply:content.interactive_reply||null,reaction:content.reaction||null,context:content.context||null,template:content.template||null,media:content.media?{kind:content.media.kind,state:content.media.state,error:content.media.error||null}:null}};}
  }
  // Reactions become chips on the message they refer to; quotes gain a preview.
  messages.splice(0,messages.length,...foldWhatsAppAnnotations(messages));
  const mediaPolicy={mimeTypes:WHATSAPP_OUTBOUND_MIME_TYPES,maxFiles:WHATSAPP_MAX_FILES,rules:WHATSAPP_MEDIA_RULES};
  if(!thread)return {customer_address:work.customer_address,customer_name:null,sending_enabled:false,window:whatsappConversationWindow(null),mediaPolicy};
  return {...thread,window:whatsappConversationWindow(thread.last_inbound_at),mediaPolicy};
}

// SMS enrichment: thread identity plus per-message provider delivery state.
// The projection is minimal on purpose; raw provider payloads stay server-side.
async function readSmsThreadDetail(db,work,messages){
  const thread=(await db.query(`SELECT t.customer_address,t.state AS thread_state,t.opted_out_at,n.id AS number_id,n.phone_number AS business_number,n.name AS number_name,n.sending_enabled
    FROM cc_sms_threads t JOIN cc_sms_numbers n ON n.id=t.number_id WHERE t.conversation_id=$1`,[work.conversation_id])).rows[0];
  const rows=messages.length?(await db.query(`SELECT message_id,direction,status,provider_message_id,encoding,parts,error_code,error_detail,occurred_at
    FROM cc_sms_messages WHERE message_id=ANY($1::uuid[])`,[messages.map(m=>m.id)])).rows:[];
  for(const message of messages){
    const row=rows.find(r=>r.message_id===message.id);
    if(row)message.delivery={status:row.status,direction:row.direction,provider_message_id:row.provider_message_id,encoding:row.encoding,parts:row.parts,error_code:row.error_code,error_detail:row.error_detail,occurred_at:row.occurred_at};
  }
  return thread?{...thread,opted_out:Boolean(thread.opted_out_at)}:{customer_address:work.customer_address,opted_out:false,sending_enabled:false};
}

export async function saveTextDraft(db,{workItemId,agentId,body,expectedVersion}){
  if(typeof body!=="string"||body.length>20000||!/^\d+$/.test(String(expectedVersion)))throw Object.assign(new Error("Invalid draft"),{status:400});
  const owned=await db.query("SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'",[workItemId,agentId]);
  if(!owned.rowCount)throw Object.assign(new Error("Accept the conversation before editing a draft"),{status:403});
  const result=await db.query(`INSERT INTO acd_text_drafts(work_item_id,agent_id,body) SELECT $1,$2,$3 WHERE $4::bigint=0
    ON CONFLICT(work_item_id,agent_id) DO NOTHING RETURNING body,version`,[workItemId,agentId,body,expectedVersion]);
  if(result.rowCount)return result.rows[0];
  const updated=await db.query(`UPDATE acd_text_drafts SET body=$3,version=version+1,updated_at=now()
    WHERE work_item_id=$1 AND agent_id=$2 AND version=$4 RETURNING body,version`,[workItemId,agentId,body,expectedVersion]);
  if(!updated.rowCount)throw Object.assign(new Error("Draft changed in another session; reload to review it"),{status:409});
  return updated.rows[0];
}
