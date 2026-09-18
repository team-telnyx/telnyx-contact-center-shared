import { randomUUID } from "node:crypto";
import { z } from "zod";
import { queueChatConversation } from "../acd/text-lifecycle.mjs";
import { evaluateWidgetDecisions } from "./decisions.js";
import { parseWidgetConfig } from "./config.js";
import { getWidgetSession } from "./sessions.js";
import { eligibleWidgetHandoffQueues } from "./handoff-context.js";
import { equalWidgetSecret, widgetHandoffServiceToken, widgetHandoffToken, widgetSessionToken } from "./session-tokens.js";

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const schema=z.object({
  widget_session_id:z.string().uuid(),telnyx_conversation_channel:z.literal("web_chat"),
  queue_name:z.string().trim().min(1).max(200).optional(),
  reason:z.string().trim().min(1).max(500),summary:z.string().trim().min(1).max(4000),
  intent:z.string().trim().max(200).default(""),
  sentiment:z.enum(["positive","neutral","negative","mixed","unknown"]).default("unknown"),
}).strict();

export async function authenticateWidgetHandoff(db, token) {
  if (typeof token !== "string" || token.length !== 43) throw fail("Unauthorized handoff",401);
  const integration=(await db.query("SELECT installation_id FROM cc_widget_handoff_integration WHERE singleton=true AND tool_id IS NOT NULL")).rows[0];
  if(!integration || !equalWidgetSecret(token,widgetHandoffServiceToken(integration.installation_id)))throw fail("Unauthorized handoff",401);
}

async function importAiTranscript(tx, session, work) {
  const commands=(await tx.query("SELECT * FROM cc_widget_ai_commands WHERE session_id=$1 AND state<>'rejected' ORDER BY created_at,client_id",[session.id])).rows;
  const messages=[];
  const add=(role,sender,client,body,at)=>messages.push({id:randomUUID(),role,sender,client,body,at,ordinal:messages.length});
  if(session.greeting)add("system","widget-ai","ai_greeting",session.greeting,session.created_at);
  for(const command of commands){
    add("customer",session.id,command.client_id,command.content.trim(),command.created_at);
    if(command.state==="completed" && command.reply)add("system","widget-ai",`ai_${command.client_id}`,command.reply,command.updated_at);
  }
  if(messages.length)await tx.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body,created_at)
    SELECT x.id,$1,$2,x.role,x.sender,x.client,x.body,x.at FROM jsonb_to_recordset($3::jsonb)
      AS x(id uuid,role text,sender text,client text,body text,at timestamptz,ordinal int)
    ORDER BY x.ordinal ON CONFLICT(conversation_id,sender_role,sender_id,client_id) DO NOTHING`,[session.conversation_id,work.id,JSON.stringify(messages)]);
}

// Authentication is performed by the HTTP ingress before parsing the body. This
// second, session-specific capability is never exposed to the embedding page.
export async function handoffWidgetChat(pool, {body,sessionToken}) {
  const parsed=schema.safeParse(body);
  if(!parsed.success)throw fail("Invalid chat handoff request");
  const input=parsed.data;
  if(!equalWidgetSecret(sessionToken,widgetHandoffToken(input.widget_session_id)))throw fail("Unauthorized widget session",401);
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    const session=await getWidgetSession(tx,widgetSessionToken(input.widget_session_id),{lock:true});
    const current=evaluateWidgetDecisions(parseWidgetConfig(session.current_config),session.context);
    const decision=evaluateWidgetDecisions(session.config,session.context);
    if(!session.widget_enabled || !current.visible || !decision.visible || !current.config.channels.messaging.enabled || !decision.config.channels.messaging.enabled)
      throw fail("Messaging is disabled for this widget",403);
    const previous=(await tx.query("SELECT * FROM cc_widget_handoffs WHERE session_id=$1",[session.id])).rows[0];
    if(previous?.work_item_id){
      await tx.query("COMMIT");
      return {ok:true,status:"handed_off",queue_name:previous.queue_name,work_item_id:previous.work_item_id,already_handed_off:true};
    }
    const conversation=(await tx.query("SELECT state FROM acd_conversations WHERE id=$1",[session.conversation_id])).rows[0];
    if(session.runtime_kind!=="ai_chat" || session.runtime_state!=="active" || !session.provider_conversation_id || conversation?.state!=="open")
      throw fail("An active widget AI chat is required for handoff",409);
    const queues=await eligibleWidgetHandoffQueues(tx,session);
    const preferred=input.queue_name || session.context?.["routing.queue"] || session.context?.routing_queue
      || decision.config.channels.messaging.routing.queueId;
    const matches=preferred?queues.filter(q=>q.id===preferred || q.name===preferred):queues;
    const queue=matches.length===1?matches[0]:null;
    if(!queue){
      const error=queues.length?"Select one of the eligible chat queues":"No eligible queue is accepting chat";
      await tx.query(`INSERT INTO cc_widget_handoffs(session_id,status,queue_name,reason,summary,intent,sentiment,error)
        VALUES($1,'failed',$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id) DO UPDATE SET
        status='failed',queue_name=$2,reason=$3,summary=$4,intent=$5,sentiment=$6,error=$7,updated_at=now()`,
        [session.id,input.queue_name||null,input.reason,input.summary,input.intent,input.sentiment,error]);
      await tx.query("COMMIT");
      // A business failure is a tool result: the AI can ask the customer which
      // eligible queue they need and retry without ending the AI conversation.
      return {ok:false,status:"failed",error,available_queues:queues.map(q=>q.name)};
    }
    const handoff={reason:input.reason,summary:input.summary,intent:input.intent,sentiment:input.sentiment,
      assistant_id:session.assistant_id,provider_conversation_id:session.provider_conversation_id};
    const context=session.context||{};
    const customerName=decision.matchedRule?.actions.some(a=>a.type==="customer-label")?decision.customerLabel
      :String(context["customer.name"]||context.customer_name||"Website visitor");
    const work=await queueChatConversation(tx,{conversationId:session.conversation_id,queueId:queue.id,customerName,
      attributes:{widget_id:session.widget_id,widget_revision_id:session.revision_id,context,origin:session.origin,handoff},actor:"ai-handoff"});
    await importAiTranscript(tx,session,work);
    await tx.query(`INSERT INTO cc_widget_handoffs(session_id,work_item_id,queue_id,queue_name,status,reason,summary,intent,sentiment)
      VALUES($1,$2,$3,$4,'waiting',$5,$6,$7,$8) ON CONFLICT(session_id) DO UPDATE SET
      work_item_id=$2,queue_id=$3,queue_name=$4,status='waiting',reason=$5,summary=$6,intent=$7,sentiment=$8,error=NULL,updated_at=now()`,
      [session.id,work.id,queue.id,queue.name,input.reason,input.summary,input.intent,input.sentiment]);
    await tx.query(`UPDATE cc_widget_sessions SET runtime_kind='human',runtime_state='active',typing_until=NULL,
      expires_at=now()+($2::text||' minutes')::interval,last_seen_at=now() WHERE id=$1`,
      [session.id,Math.max(5,Number(session.config.behavior.inactivityMinutes)||30)]);
    await tx.query("COMMIT");
    return {ok:true,status:"handed_off",queue_name:queue.name,work_item_id:work.id,
      instruction:"The conversation now belongs to the human queue. Stop answering; the widget displays the handoff notifications."};
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
