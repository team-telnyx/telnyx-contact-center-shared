import { createHash } from 'node:crypto';
import { requireEmailWork,sendAgentEmail } from './store.mjs';
import { address } from './policy.mjs';
import { emailError,fetchEmailContent } from './provider.mjs';
import { readEmailFile } from './private-storage.mjs';

// A manual destination forwards a copy. It never changes the sender mailbox,
// recipient reply permissions, active assignment, or the agent's existing draft.
export async function forwardEmailWork(pool,{workItemId,agentId,messageId,to,commandId,expectedVersion},{provider,readFile=readEmailFile,fetchContent=fetchEmailContent}={}){
  const recipient=address(to);
  if(typeof messageId!=='string'||!messageId)throw emailError('Select an email to forward');
  if(!/^[a-f0-9-]{36}$/i.test(commandId||'')||expectedVersion==null)throw emailError('Command ID and interaction version are required');
  // Journal the caller's immutable intent, not attachment bytes that may no
  // longer be available when confirming an already accepted request.
  const journalHash=createHash('sha256').update(JSON.stringify({action:'forward_email',messageId,to:recipient,expectedVersion})).digest('hex');
  const prior=(await pool.query('SELECT request_hash,result FROM acd_text_commands WHERE work_item_id=$1 AND actor_id=$2 AND command_id=$3',[workItemId,agentId,commandId])).rows[0];
  if(prior){
    if(prior.request_hash!==journalHash)throw emailError('Command ID already used for different content',409);
    return prior.result;
  }
  const work=await requireEmailWork(pool,{workItemId,agentId,active:true});
  const row=(await pool.query(`SELECT m.body,e.envelope FROM acd_messages m JOIN cc_email_messages e ON e.message_id=m.id
    WHERE m.id=$1 AND m.conversation_id=$2 AND m.sender_role='customer' AND e.provider_message_id IS NOT NULL`,[messageId,work.conversation_id])).rows[0];
  if(!row)throw emailError('The email to forward is unavailable',404);
  const files=row.envelope.attachments||[];
  if(files.length>20)throw emailError('Forwarding supports at most 20 attachments',413);
  const attachments=[];let total=0;
  for(const file of files){
    if(total+Number(file.size_bytes||0)>5_000_000)throw emailError('Forwarded attachments must total at most 5 MB',413);
    const bytes=file.storage_key?await readFile(file.storage_key):await fetchContent(file.url,5_000_000-total);
    total+=bytes.length;if(total>5_000_000)throw emailError('Forwarded attachments must total at most 5 MB',413);
    attachments.push({filename:file.filename||file.name||'attachment',content_type:file.content_type,content:bytes.toString('base64')});
  }
  return sendAgentEmail(pool,{workItemId,agentId,commandId,expectedVersion,content:{mode:'forward',replyMessageId:messageId,to:recipient,cc:'',bcc:'',
    subject:`Fwd: ${String(row.envelope.subject||'(No subject)').replace(/^Fwd:\s*/i,'')}`.slice(0,998),
    text:`---------- Forwarded message ----------\nFrom: ${row.envelope.from}\nSubject: ${row.envelope.subject||''}\n\n${row.body||''}`,
    html:'',attachments,scheduledAt:null}},{...(provider?{provider}:{}),journalHash});
}

// A composer seed only; this operation never sends mail or changes ownership.
export async function prepareForwardDraft(pool,{workItemId,agentId,messageId},{readFile=readEmailFile,fetchContent=fetchEmailContent}={}) {
  const work=await requireEmailWork(pool,{workItemId,agentId,active:true});
  const row=(await pool.query(`SELECT m.body,e.html_body,e.envelope FROM acd_messages m JOIN cc_email_messages e ON e.message_id=m.id
    WHERE m.id=$1 AND m.conversation_id=$2 AND m.sender_role='customer'`,[messageId,work.conversation_id])).rows[0];
  if(!row)throw emailError('The email to forward is unavailable',404);
  const attachments=[];let total=0;
  for(const file of row.envelope.attachments||[]){
    if(attachments.length>=20||total+Number(file.size_bytes||0)>5_000_000)throw emailError('Forwarding supports at most 20 attachments, totalling 5 MB',413);
    const bytes=file.storage_key?await readFile(file.storage_key):await fetchContent(file.url,5_000_000-total);
    total+=bytes.length;if(total>5_000_000)throw emailError('Forwarded attachments must total at most 5 MB',413);
    attachments.push({filename:file.filename||file.name||'attachment',content_type:file.content_type,content:bytes.toString('base64'),size_bytes:bytes.length,
      ...(file.content_id?{content_id:file.content_id,disposition:'inline'}:{})});
  }
  const heading=`---------- Forwarded message ----------\nFrom: ${row.envelope.from}\nTo: ${(row.envelope.to||[]).join(', ')}\nSubject: ${row.envelope.subject||''}`;
  const escape=value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  return {content:{mode:'forward',replyMessageId:messageId,to:'',cc:'',bcc:'',subject:`Fwd: ${String(row.envelope.subject||'').replace(/^Fwd:\s*/i,'')}`.slice(0,998),
    text:`\n\n${heading}\n\n${row.body||''}`,html:`<p><br></p><blockquote data-email-forward="true">${escape(heading)}<br><br>${row.html_body||escape(row.body)}</blockquote>`,attachments,scheduledAt:null}};
}
