import { randomUUID, createHash } from 'node:crypto';
import { appendEvent } from '../acd/events.mjs';
import { defineSaga, startSaga, driveSaga, cancelWaitingSaga } from '../acd/saga-engine.mjs';
import { emailError, emailProvider } from './provider.mjs';
import { parseEmailDraft, buildAgentEmail, rfcIds } from './policy.mjs';
import { emailSendFailure } from './send-limits.mjs';
import { loadEmailPreviewSettings } from './preview-settings.mjs';

export async function requireEmailWork(db,{workItemId,agentId,active=false}) {
  const row=(await db.query(`SELECT w.* FROM acd_work_items w WHERE w.id=$1 AND w.channel='email' AND (
    EXISTS(SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id WHERE a.work_item_id=w.id AND a.agent_id=$2
      AND (a.state='active' OR ($3=false AND ((a.state='wrapup' AND s.outcome IS DISTINCT FROM 'transferred') OR w.terminal_at IS NOT NULL))))
    OR ($3=false AND EXISTS(SELECT 1 FROM acd_offers o WHERE o.work_item_id=w.id AND o.agent_id=$2 AND o.state IN ('created','ringing'))))`,[workItemId,agentId,active])).rows[0];
  if(!row)throw emailError('Email is not assigned to you',403);
  return row;
}
export async function readEmailDetail(db, identity) {
  const work=await requireEmailWork(db,identity);
  const mailbox=(await db.query(`SELECT b.id,b.name,b.address,b.sending_enabled,t.subject,t.state FROM cc_email_threads t
    JOIN cc_email_mailboxes b ON b.id=t.mailbox_id WHERE t.conversation_id=$1`,[work.conversation_id])).rows[0];
  const rows=(await db.query(`SELECT m.*,e.provider_message_id,e.envelope,e.html_body,e.status,e.saga_id,
    u.first_name,u.last_name,u.profile_picture_uri,failure.provider_error,failure.provider_error_code,failure.http_status FROM acd_messages m JOIN cc_email_messages e ON e.message_id=m.id
    LEFT JOIN LATERAL (SELECT c.response->>'error' AS provider_error,c.response->>'code' AS provider_error_code,c.http_status
      FROM acd_commands c WHERE c.saga_id=e.saga_id AND c.status='failed' ORDER BY c.created_at DESC LIMIT 1) failure ON e.status='failed'
    LEFT JOIN users u ON m.sender_role='agent' AND u.id=m.sender_id WHERE m.conversation_id=$1 ORDER BY m.created_at,m.seq`,[work.conversation_id])).rows;
  const deliveries=(await db.query(`SELECT d.* FROM cc_email_deliveries d JOIN acd_messages m ON m.id=d.message_id WHERE m.conversation_id=$1`,[work.conversation_id])).rows;
  const messages=rows.map(({provider_error,provider_error_code,http_status,...row})=>{
    const {bcc:_bcc,attachments=[],...envelope}=row.envelope;
    return {...row,envelope,sendError:emailSendFailure({error:provider_error,code:provider_error_code,httpStatus:http_status}),recipient_count:['to','cc','bcc'].reduce((n,key)=>n+(Array.isArray(row.envelope[key])?row.envelope[key].length:0),0),attachments:attachments.map((file,i)=>({filename:file.filename||file.name||'attachment',content_type:file.content_type,size_bytes:file.size_bytes,content_id:file.content_id,
      url:`/api/contact-center/email/${work.id}/attachments/${row.id}/${i}`})),
      deliveries:deliveries.filter(d=>d.message_id===row.id).map(d=>({...d,address:d.kind==='bcc'?null:d.address,
        evidence:d.kind==='bcc'?{code:d.evidence?.code,source:d.evidence?.source,retryable:d.evidence?.retryable}:d.evidence}))};
  });
  const drafts=(await db.query(`SELECT d.draft_id AS id,
    CASE WHEN ($3::jsonb->>d.draft_id)=d.version::text THEN NULL ELSE d.content END AS content,
    d.content<>'null'::jsonb AS "hasContent",d.version,d.updated_at,
    d.submitted_message_id AS "submittedMessageId",e.status AS "sendStatus"
    FROM cc_email_drafts d LEFT JOIN cc_email_messages e ON e.message_id=d.submitted_message_id
    WHERE d.work_item_id=$1 AND d.agent_id=$2 ORDER BY d.created_at,d.draft_id`,[work.id,identity.agentId,JSON.stringify(identity.knownDraftVersions||{})])).rows;
  const draft=drafts.find(d=>d.id==='legacy')||{content:null,version:'0'};
  const selfAddresses=(await db.query('SELECT address FROM cc_email_mailboxes')).rows.map(r=>r.address);
  // Poll metadata for unchanged drafts instead of retransmitting attachment bytes.
  const project=row=>identity.knownDraftVersions?.[row.id]===String(row.version)?{...row,content:undefined}:row;
  return {work,mailbox,messages,draft:project(draft),drafts:drafts.filter(d=>d.hasContent).map(project),selfAddresses,preview:await loadEmailPreviewSettings(db)};
}

function validateDraftId(id) {
  if(id!=='legacy'&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id||''))throw emailError('Invalid draft ID');
}
export async function saveEmailDraft(pool,{workItemId,agentId,content,expectedVersion,draftId='legacy',discard=false}) {
  validateDraftId(draftId);
  const parsed=discard?null:parseEmailDraft(content);
  if(!/^\d+$/.test(String(expectedVersion)))throw emailError('Draft version is required');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT id FROM acd_work_items WHERE id=$1 FOR UPDATE',[workItemId]);
    await requireEmailWork(db,{workItemId,agentId,active:true});
    const existing=(await db.query(`SELECT d.*,e.status AS send_status FROM cc_email_drafts d
      LEFT JOIN cc_email_messages e ON e.message_id=d.submitted_message_id
      WHERE work_item_id=$1 AND agent_id=$2 AND draft_id=$3`,[workItemId,agentId,draftId])).rows[0];
    if(existing?.submitted_message_id&&!['failed','cancelled'].includes(existing.send_status))throw emailError('This draft is being sent. Wait for confirmation.',409);
    if(String(expectedVersion)==='0'&&!existing){
      const count=(await db.query(`SELECT count(*)::int AS count FROM cc_email_drafts WHERE work_item_id=$1 AND agent_id=$2 AND content<>'null'::jsonb`,[workItemId,agentId])).rows[0].count;
      if(count>=20)throw emailError('At most 20 draft tabs are allowed',409);
    }
    let result;
    if(String(expectedVersion)==='0')result=await db.query(`INSERT INTO cc_email_drafts(work_item_id,agent_id,draft_id,content) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT DO NOTHING RETURNING content,version`,[workItemId,agentId,draftId,JSON.stringify(parsed)]);
    else result=await db.query(`UPDATE cc_email_drafts SET content=$4::jsonb,version=version+1,updated_at=now(),submitted_message_id=NULL
      WHERE work_item_id=$1 AND agent_id=$2 AND draft_id=$3 AND version=$5 RETURNING content,version`,[workItemId,agentId,draftId,JSON.stringify(parsed),expectedVersion]);
    if(!result.rowCount)throw emailError('Draft changed in another session. Reload the saved draft before sending.',409);
    await appendEvent(db,{workItemId,agentId,type:'email_draft_updated',actor:agentId,
      payload:{draft_version:String(result.rows[0].version),...(draftId==='legacy'?{}:{draft_id:draftId})}});
    await db.query('COMMIT');return result.rows[0];
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

async function markSend(db,ctx,status) {
  await db.query('UPDATE cc_email_messages SET status=$2 WHERE message_id=$1',[ctx.data.messageId,status]);
  await appendEvent(db,{workItemId:ctx.workItem.id,type:'email_send_updated',actor:'email',payload:{message_id:ctx.data.messageId,status}});
}
defineSaga('email_send',{
  initialStep:'scheduled',steps:{
    scheduled:{run:async(_db,ctx)=>!ctx.data.sendAt||Date.parse(ctx.data.sendAt)<=Date.now()?'send':null,
      deadlineMs:ctx=>Math.max(1,Date.parse(ctx.data.sendAt||new Date())-Date.now()),onDeadline:'send'},
    send:{
      async guard(db,ctx){
        // Also fence drafts scheduled by an older client/build: every send
        // must originate from a customer message in this conversation.
        const parent=ctx.data.replyParentId||ctx.data.payload.in_reply_to_message_id||ctx.data.payload.forward_of_message_id;
        if(!parent)return 'rejected';
        const allowed=await db.query(`SELECT 1 FROM acd_text_assignments a JOIN cc_email_mailboxes b ON b.id=$3
          WHERE a.work_item_id=$1 AND a.agent_id=$2 AND a.state='active' AND b.sending_enabled
            AND EXISTS(SELECT 1 FROM acd_messages m JOIN cc_email_messages e ON e.message_id=m.id
              WHERE m.conversation_id=$4 AND m.sender_role='customer' AND e.provider_message_id=$5)`,
        [ctx.workItem.id,ctx.data.agentId,ctx.data.mailboxId,ctx.workItem.conversation_id,parent]);
        return allowed.rowCount?null:'rejected';
      },
      cmd:ctx=>({operation:'email_send',endpoint:'/email_messages',request:ctx.data.payload}),
      dedupeWindowMs:23*60*60*1000, deadlineMs:23*60*60*1000,onDeadline:'uncertain',onFailure:'rejected',on:{accepted:'succeeded'},
      async onAccepted(db,{saga,response}){
        const id=response.data.id;
        await db.query(`UPDATE cc_email_drafts SET content='null',version=version+1,updated_at=now()
          WHERE submitted_message_id=$1 AND content<>'null'::jsonb`,[saga.data.messageId]);
        await db.query("UPDATE cc_email_messages SET provider_message_id=$2,status='accepted' WHERE message_id=$1",[saga.data.messageId,id]);
        if(response.data.thread_id)await db.query(`UPDATE cc_email_threads SET provider_thread_id=$2 WHERE conversation_id=
          (SELECT conversation_id FROM acd_messages WHERE id=$1) AND provider_thread_id LIKE 'outbound:%'`,[saga.data.messageId,String(response.data.thread_id)]);
        const rfcId=rfcIds(response.data.message_id)[0];
        if(rfcId)await db.query('UPDATE cc_email_messages SET rfc_message_id=$2 WHERE message_id=$1',[saga.data.messageId,rfcId]);
        await appendEvent(db,{workItemId:saga.work_item_id,type:'email_send_updated',actor:'email',payload:{message_id:saga.data.messageId,status:'accepted'}});
      },
    },
    rejected:{run:async(db,ctx)=>{await markSend(db,ctx,'failed');return 'failed';}},
    uncertain:{run:async(db,ctx)=>{await markSend(db,ctx,'ambiguous');return 'failed';}},
  },
});

export async function sendAgentEmail(pool,{workItemId,agentId,commandId,expectedVersion,content,draftVersion,draftId='legacy',retainDraft=false}, {provider=emailProvider(),journalHash}={}) {
  validateDraftId(draftId);
  if(!/^[a-f0-9-]{36}$/i.test(commandId||'') || expectedVersion==null)throw emailError('Command ID and interaction version are required');
  // Internal forwarding can supply its stable intent hash. HTTP request
  // fields never populate this options argument.
  const keepDraft=retainDraft||draftId!=='legacy';
  const hash=journalHash??createHash('sha256').update(JSON.stringify({content,expectedVersion,draftVersion,...(draftId==='legacy'?{}:{draftId}),...(retainDraft?{retainDraft:true}:{})})).digest('hex');
  const db=await pool.connect();let sagaId,result;
  try{
    await db.query('BEGIN');
    await db.query('SELECT id FROM acd_work_items WHERE id=$1 FOR UPDATE',[workItemId]);
    const work=await requireEmailWork(db,{workItemId,agentId,active:true});
    const prior=(await db.query('SELECT * FROM acd_text_commands WHERE work_item_id=$1 AND actor_id=$2 AND command_id=$3',[workItemId,agentId,commandId])).rows[0];
    if(prior){
      if(prior.request_hash!==hash)throw emailError('Command ID already used for different content',409);
      await db.query('COMMIT');return prior.result;
    }
    if(String(work.version)!==String(expectedVersion))throw emailError('Interaction changed. Refresh and retry.',409);
    if(draftVersion!=null){
      const draft=(await db.query('SELECT version,submitted_message_id FROM cc_email_drafts WHERE work_item_id=$1 AND agent_id=$2 AND draft_id=$3 FOR UPDATE',[workItemId,agentId,draftId])).rows[0];
      if(draft?.submitted_message_id)throw emailError('This draft already has a send in progress',409);
      if(String(draft?.version||0)!==String(draftVersion))throw emailError('Draft changed in another session',409);
    }
    const mailbox=(await db.query('SELECT b.* FROM cc_email_threads t JOIN cc_email_mailboxes b ON b.id=t.mailbox_id WHERE t.conversation_id=$1',[work.conversation_id])).rows[0];
    const original=content.replyMessageId?(await db.query(`SELECT e.* FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id
      WHERE m.id=$1 AND m.conversation_id=$2 AND m.sender_role='customer'`,[content.replyMessageId,work.conversation_id])).rows[0]:null;
    const selfAddresses=(await db.query('SELECT address FROM cc_email_mailboxes')).rows.map(r=>r.address);
    const {draft,payload,replyParentId}=buildAgentEmail({draft:content,mailbox,original,selfAddresses});
    const messageId=randomUUID();
    await db.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body)
      VALUES($1,$2,$3,'agent',$4,$5,$6)`,[messageId,work.conversation_id,workItemId,agentId,commandId,draft.text]);
    const started=await startSaga(db,{type:'email_send',workItemId,conflictKey:`email:${messageId}`,
      data:{messageId,mailboxId:mailbox.id,agentId,payload,replyParentId,sendAt:draft.scheduledAt},actor:agentId});
    sagaId=started.sagaId;
    await db.query(`INSERT INTO cc_email_messages(message_id,mailbox_id,envelope,html_body,status,saga_id)
      VALUES($1,$2,$3::jsonb,$4,$5,$6)`,[messageId,mailbox.id,JSON.stringify({from:mailbox.address,to:payload.to,cc:payload.cc,bcc:payload.bcc,subject:payload.subject,
        scheduledAt:draft.scheduledAt,attachments:draft.attachments.map(({content:_content,...a})=>a)}),draft.html,draft.scheduledAt?'scheduled':'queued',sagaId]);
    result={ok:true,messageId,sagaId,status:draft.scheduledAt?'scheduled':'queued'};
    await db.query(`INSERT INTO acd_text_commands(work_item_id,actor_id,command_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`,[workItemId,agentId,commandId,hash,JSON.stringify(result)]);
    if(draftVersion!=null)await db.query(`UPDATE cc_email_drafts SET
      content=CASE WHEN $6 THEN 'null'::jsonb ELSE content END,
      submitted_message_id=CASE WHEN $7 THEN $5::uuid ELSE NULL END,
      version=version+1,updated_at=now() WHERE work_item_id=$1 AND agent_id=$2 AND draft_id=$3 AND version=$4`,
      [workItemId,agentId,draftId,draftVersion,messageId,!keepDraft||Boolean(draft.scheduledAt),keepDraft]);
    await appendEvent(db,{workItemId,type:'text_message_created',actor:agentId,payload:{message_id:messageId,conversation_id:work.conversation_id,sender_role:'agent'}});
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  await driveSaga(pool,sagaId,{provider}).catch(()=>undefined);
  return result;
}

export async function cancelScheduledEmail(pool,{workItemId,agentId,messageId}) {
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query('SELECT id FROM acd_work_items WHERE id=$1 FOR UPDATE',[workItemId]);
    await requireEmailWork(db,{workItemId,agentId,active:true});
    const message=(await db.query(`SELECT e.* FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id
      WHERE e.message_id=$1 AND m.work_item_id=$2 AND m.sender_id=$3`,[messageId,workItemId,agentId])).rows[0];
    if(!message)throw emailError('Scheduled email not found',404);
    const saga=(await db.query('SELECT * FROM acd_sagas WHERE id=$1 FOR UPDATE',[message.saga_id])).rows[0];
    if(message.status==='cancelled'){await db.query('COMMIT');return {ok:true};}
    if(saga.step!=='scheduled'||saga.state!=='running')throw emailError('Email is already being sent and cannot be cancelled',409);
    if(!await cancelWaitingSaga(db,saga.id,{type:'email_send',step:'scheduled'}))throw emailError('Email is already being sent',409);
    await db.query("UPDATE cc_email_messages SET status='cancelled' WHERE message_id=$1",[messageId]);
    await appendEvent(db,{workItemId,type:'email_send_cancelled',actor:agentId,payload:{message_id:messageId}});
    await db.query('COMMIT');return {ok:true};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
