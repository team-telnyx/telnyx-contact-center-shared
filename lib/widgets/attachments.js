import { createHash,randomUUID } from "node:crypto";
import { appendTextMessage } from "../acd/text-lifecycle.mjs";
import { getWidgetSession } from "./sessions.js";
import { parseAttachmentByteRange } from "./attachment-ranges.js";
import { attachmentResponseHeaders } from "./attachment-headers.js";
import { normalizeAttachmentMimeType, isAttachmentTypeAllowed } from "./attachment-types.mjs";

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export const MAX_ATTACHMENT_BYTES=100*1048576;

export async function boundedMultipart(request,maximumBytes=MAX_ATTACHMENT_BYTES){
  if(Number(request.headers.get("content-length"))>maximumBytes+65536)throw fail("File is too large",413);
  const reader=request.body?.getReader();if(!reader)throw fail("File is required");
  const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
    if(length>maximumBytes+65536){await reader.cancel();throw fail("File is too large",413);}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return new Response(Buffer.concat(chunks),{headers:{"Content-Type":request.headers.get("content-type")||""}}).formData();
}

export function validateAttachment(bytes,type){
  const head=bytes.subarray(0,16),hex=head.toString("hex"),ascii=head.toString("ascii");
  const signatures={
    "image/png":()=>hex.startsWith("89504e470d0a1a0a"),"image/jpeg":()=>hex.startsWith("ffd8ff"),
    "image/gif":()=>/^GIF8[79]a/.test(ascii),"image/webp":()=>ascii.startsWith("RIFF")&&ascii.slice(8,12)==="WEBP",
    "application/pdf":()=>ascii.startsWith("%PDF-"),"audio/mpeg":()=>ascii.startsWith("ID3")||(head[0]===255&&(head[1]&224)===224),
    "audio/wav":()=>ascii.startsWith("RIFF")&&ascii.slice(8,12)==="WAVE", "video/mp4":()=>ascii.slice(4,8)==="ftyp",
    "application/zip":()=>/^504b(0304|0506|0708)/.test(hex),
    "application/msword":()=>hex.startsWith("d0cf11e0a1b11ae1"),
    "application/vnd.ms-excel":()=>hex.startsWith("d0cf11e0a1b11ae1"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":()=>hex.startsWith("504b0304"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":()=>hex.startsWith("504b0304"),
    "text/plain":()=>!bytes.includes(0)&&Buffer.from(bytes.toString("utf8")).equals(bytes),
    "text/csv":()=>!bytes.includes(0)&&Buffer.from(bytes.toString("utf8")).equals(bytes),
    "text/markdown":()=>!bytes.includes(0)&&Buffer.from(bytes.toString("utf8")).equals(bytes),
  };
  if(!bytes.length||!signatures[type]?.())throw fail("File content does not match a supported attachment type");
}

export async function attachmentContext(tx, {token,agentId,workItemId}) {
  let session=token?await getWidgetSession(tx,token):null;
  if(session && session.runtime_kind !== "human") throw fail("Attachments are unavailable for this conversation",403);
  const work=(await tx.query(`SELECT w.* FROM acd_work_items w WHERE w.channel='chat' AND
    (($1::uuid IS NOT NULL AND w.id=$1) OR ($2::uuid IS NOT NULL AND w.conversation_id=$2)) FOR UPDATE`,[workItemId||null,session?.conversation_id||null])).rows[0];
  if(!work)throw fail("Chat not found",404);
  if(agentId){
    const owns=await tx.query("SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'",[work.id,agentId]);
    if(!owns.rowCount)throw fail("Accept the chat before sending a file",403);
    const row=(await tx.query(`SELECT r.config FROM cc_widget_sessions s JOIN cc_widget_revisions r ON r.id=s.revision_id WHERE s.conversation_id=$1`,[work.conversation_id])).rows[0];
    session={config:row?.config};
  }
  const conversation=(await tx.query("SELECT state FROM acd_conversations WHERE id=$1",[work.conversation_id])).rows[0];
  if(conversation?.state!=="open")throw fail("Conversation has ended",409);
  const config=session?.config,policy=config?.features?.attachmentPolicy;
  const mimeTypes=policy?.[agentId?"outboundMimeTypes":"inboundMimeTypes"];
  if(!config?.features?.attachmentsAfterHandoff || !mimeTypes?.length)throw fail("Attachments are disabled for the widget",403);
  return {work,session,mimeTypes,maximumBytes:Math.min(MAX_ATTACHMENT_BYTES,policy.maximumFileSizeMb*1048576)};
}

// Admission counts attempts, including invalid bodies, and reserves in-flight
// slots atomically. Exhausted/disabled/closed sessions never read request.body.
export async function admitTextAttachment(pool, identity) {
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN");
    const context=await attachmentContext(tx,identity);
    await tx.query(`DELETE FROM cc_attachment_uploads WHERE conversation_id=$1
      AND created_at<now()-interval '1 minute' AND (finished_at IS NOT NULL OR expires_at<=now())`,[context.work.conversation_id]);
    const count=(await tx.query(`SELECT count(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS recent,
      count(*) FILTER(WHERE finished_at IS NULL AND expires_at>now())::int AS active
      FROM cc_attachment_uploads WHERE conversation_id=$1`,[context.work.conversation_id])).rows[0];
    if(count.recent>=10 || count.active>=2)throw fail("Please wait before uploading another attachment",429);
    const id=randomUUID();
    await tx.query(`INSERT INTO cc_attachment_uploads(id,conversation_id,expires_at)
      VALUES($1,$2,now()+interval '2 minutes')`,[id,context.work.conversation_id]);
    await tx.query("COMMIT");
    return {id,...context};
  } catch(error) {await tx.query("ROLLBACK");throw error;} finally {tx.release();}
}

export async function finishUpload(pool,id) {
  await pool.query("UPDATE cc_attachment_uploads SET finished_at=now() WHERE id=$1",[id]);
}

export async function receiveTextAttachment(pool, {request,...identity}) {
  const admission=await admitTextAttachment(pool,identity);
  try {
    const {withStreamedAttachment}=await import("./multipart-upload.js");
    return await withStreamedAttachment(request,admission,({file,clientId})=>
      uploadTextAttachment(pool,{...identity,file,clientId,admission}));
  } finally {await finishUpload(pool,admission.id);}
}

export async function uploadTextAttachment(pool,{token,agentId,workItemId,file,clientId,admission}){
  const identity={token,agentId,workItemId};
  const admitted=admission || await admitTextAttachment(pool,identity);
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    const {work,session,mimeTypes,maximumBytes}=await attachmentContext(tx,identity);
    const lease=await tx.query(`SELECT 1 FROM cc_attachment_uploads WHERE id=$1 AND conversation_id=$2
      AND finished_at IS NULL AND expires_at>now()`,[admitted.id,work.conversation_id]);
    if(!lease.rowCount)throw fail("Upload admission expired",409);
    if(!file||typeof file.arrayBuffer!=="function")throw fail("File is required");
    const type=normalizeAttachmentMimeType(file.type,file.name);
    if(!isAttachmentTypeAllowed(type,file.name,mimeTypes))throw fail("This attachment type is disabled for the widget",403);
    if(file.size>maximumBytes)throw fail("File exceeds the widget's size limit",413);
    const bytes=Buffer.from(await file.arrayBuffer());
    if(bytes.length>maximumBytes)throw fail("File exceeds the widget's size limit",413);
    validateAttachment(bytes,type);
    const name=String(file.name||"attachment").replace(/[\x00-\x1f\x7f/\\]/g,"_").slice(0,240);
    const digest=createHash("sha256").update(bytes).digest("hex");
    const message=await appendTextMessage(tx,{work,senderRole:agentId?"agent":"customer",senderId:agentId||session.id,clientId,body:name});
    const existing=(await tx.query("SELECT * FROM acd_text_attachments WHERE message_id=$1",[message.id])).rows[0];
    if(existing&&existing.content_hash!==digest)throw fail("Attachment ID was already used for different content",409);
    if(!existing)await tx.query(`INSERT INTO acd_text_attachments(id,message_id,conversation_id,name,content_type,bytes,byte_size,content_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),message.id,work.conversation_id,name,type,bytes,bytes.length,digest]);
    await tx.query("COMMIT");return {messageId:message.id,clientId:message.client_id,conversationId:work.conversation_id};
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();if(!admission)await finishUpload(pool,admitted.id);}
}

export function attachmentResponse(request,attachment){
  // Both callers have already authorized the original attachment. Preserve the
  // same session/assignment checks for previews, including cached conversions.
  if(new URL(request.url).searchParams.get("preview")==="1"){
    return import("../documents/preview-service.mjs").then(({documentPreviewResponse})=>documentPreviewResponse(attachment,request));
  }
  const headers={...attachmentResponseHeaders({mimeType:attachment.content_type,filename:attachment.name},attachment.byte_size),"Accept-Ranges":"bytes","Referrer-Policy":"no-referrer"};
  const range=request.headers.get("range");
  if(!range)return new Response(attachment.bytes,{headers});
  const parsed=parseAttachmentByteRange(range,attachment.byte_size);
  if(!parsed)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${attachment.byte_size}`}});
  const bytes=attachment.bytes.subarray(parsed.start,parsed.end+1);
  // Match the existing header's casing: Headers combines differently cased
  // object keys, producing an invalid Content-Length such as "4106238, 2".
  return new Response(bytes,{status:206,headers:{...headers,"content-length":String(bytes.length),"Content-Range":`bytes ${parsed.start}-${parsed.end}/${attachment.byte_size}`}});
}
