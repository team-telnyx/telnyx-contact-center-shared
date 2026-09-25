import { createHash } from "node:crypto";
import { admitTextAttachment,attachmentContext,finishUpload,validateAttachment } from "../widgets/attachments.js";
import { withStreamedChatMessage } from "../widgets/multipart-upload.js";
import { isAttachmentTypeAllowed } from "../widgets/attachment-types.mjs";
import { actOnTextWork } from "../acd/text-lifecycle.mjs";
import { MAX_CHAT_FILES,MAX_CHAT_FILE_BYTES } from "./chat-compose-limits.mjs";

const fail=(message,status=400)=>Object.assign(new Error(message),{status});

export async function receiveAgentChatMessage(pool,{request,workItemId,agentId,draftScope="legacy"}){
  const identity={workItemId,agentId,draftScope},admission=await admitTextAttachment(pool,identity);
  try{
    return await withStreamedChatMessage(request,{...admission,maximumFiles:MAX_CHAT_FILES,maximumTotalBytes:MAX_CHAT_FILE_BYTES},async({files,metadata})=>{
      let message;try{message=JSON.parse(metadata);}catch{throw fail("Invalid message metadata");}
      if(!message||typeof message.body!=="string"||message.body.length>20000||typeof message.commandId!=="string"||!message.commandId||message.commandId.length>100||
        !/^\d+$/.test(String(message.expectedVersion))||!/^\d+$/.test(String(message.draftVersion)))throw fail("Message, command ID and draft versions are required");
      const attachments=[];
      for(const file of files){
        const bytes=Buffer.from(await file.arrayBuffer());validateAttachment(bytes,file.type);
        attachments.push({name:String(file.name||"attachment").replace(/[\x00-\x1f\x7f/\\]/g,"_").slice(0,240),content_type:file.type,bytes,byte_size:bytes.length,content_hash:createHash("sha256").update(bytes).digest("hex")});
      }
      return actOnTextWork(pool,{...identity,action:"send",channel:"chat",commandId:message.commandId,expectedVersion:message.expectedVersion,draftVersion:message.draftVersion,body:message.body},{attachments,
        beforeSend:async tx=>{
          const context=await attachmentContext(tx,identity);
          const lease=await tx.query("SELECT 1 FROM cc_attachment_uploads WHERE id=$1 AND finished_at IS NULL AND expires_at>now()",[admission.id]);
          if(!lease.rowCount)throw fail("Upload admission expired",409);
          if(attachments.some(file=>!isAttachmentTypeAllowed(file.content_type,file.name,context.mimeTypes)))throw fail("This attachment type is disabled for the widget",403);
          if(attachments.some(file=>file.byte_size>context.maximumBytes))throw fail("File exceeds the widget's size limit",413);
        }});
    });
  }finally{await finishUpload(pool,admission.id);}
}

// The authenticated actor can confirm their own command after assignment ends,
// without re-reading files or reapplying current attachment policy.
export async function readAgentChatCommand(pool,{workItemId,agentId,commandId,channel="chat"}){
  if(typeof commandId!=="string"||!commandId||commandId.length>100)throw fail("Invalid command ID");
  const row=(await pool.query(`SELECT c.result FROM acd_text_commands c JOIN acd_work_items w ON w.id=c.work_item_id AND w.channel=$4
    WHERE c.work_item_id=$1 AND c.actor_id=$2 AND c.command_id=$3`,[workItemId,agentId,commandId,channel])).rows[0];
  return {result:row?.result||null};
}
