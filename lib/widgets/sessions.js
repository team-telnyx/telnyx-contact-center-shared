import { randomUUID } from "node:crypto";
import { getPublishedWidget } from "./store.js";
import { attachmentAccessToken,hashSessionToken, verifyWidgetBootstrapToken, widgetSessionToken } from "./session-tokens.js";
import { isWidgetSessionOriginAllowed, parseWidgetConfig } from "./config.js";
import { evaluateWidgetDecisions } from "./decisions.js";
import { createChatWork, appendTextMessage, endCustomerChat } from "../acd/text-lifecycle.mjs";

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const ttl=config=>Math.max(1,Math.min(1440,Number(config.behavior.inactivityMinutes)||30));
function avatarUri(value){
  if(typeof value!=="string"||value.length>2*1048576)return null;
  return /^https:\/\//i.test(value)||/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:null;
}

export async function getWidgetSession(db,token,{lock=false}={}){
  if(typeof token!=="string"||!/^wss_[A-Za-z0-9_-]{43}$/.test(token))throw fail("Invalid widget session",401);
  const row=(await db.query(`SELECT s.*,r.config,p.config AS current_config,w.public_id,w.enabled AS widget_enabled
    FROM cc_widget_sessions s JOIN cc_widgets w ON w.id=s.widget_id
    JOIN cc_widget_revisions r ON r.id=s.revision_id
    JOIN cc_widget_revisions p ON p.id=w.published_revision_id
    WHERE s.token_hash=$1 AND s.expires_at>now() ${lock?"FOR UPDATE OF s":""}`,[hashSessionToken(token)])).rows[0];
  if(!row||!isWidgetSessionOriginAllowed(row.origin,row.current_config.allowedOrigins))throw fail("Widget session expired or disabled",401);
  return {...row,config:parseWidgetConfig(row.config)};
}

const channelForRuntime=kind=>kind==="ai_voice"?"voice":kind==="video"?"video":"messaging";

export async function readWidgetConversation(db,session){
  if (session.runtime_kind === "video") return (await import("../video/lifecycle.mjs")).readVideoWidgetState(db, session);
  if (session.runtime_kind !== "human") return (await import("./ai-sessions.js")).readAiWidgetConversation(db, session);
  const work=(await db.query(`SELECT w.*,c.state AS conversation_state FROM acd_work_items w
    JOIN acd_conversations c ON c.id=w.conversation_id WHERE w.conversation_id=$1 ORDER BY w.created_at DESC LIMIT 1`,[session.conversation_id])).rows[0];
  const assignment=(await db.query(`SELECT a.*,u.first_name,u.last_name FROM acd_text_assignments a
    JOIN acd_segments s ON s.id=a.segment_id
    LEFT JOIN users u ON u.id=a.agent_id WHERE a.work_item_id=$1 AND (a.state IN ('active','wrapup') OR $2='closed')
      AND s.outcome IS DISTINCT FROM 'transferred'
    ORDER BY s.seq DESC LIMIT 1`,[work.id,work.conversation_state])).rows[0];
  const offer=(await db.query(`SELECT o.*,u.first_name,u.last_name FROM acd_offers o LEFT JOIN users u ON u.id=o.agent_id
    WHERE o.work_item_id=$1 AND o.state IN ('created','ringing') ORDER BY o.created_at DESC LIMIT 1`,[work.id])).rows[0];
  const agent=assignment||offer;
  const queue=(await db.query("SELECT name FROM cc_queues WHERE id=$1",[work.queue_id])).rows[0];
  const attachments=(await db.query("SELECT id,message_id,name,content_type,byte_size FROM acd_text_attachments WHERE conversation_id=$1",[session.conversation_id])).rows;
  const messages=(await db.query(`SELECT m.*,u.first_name,u.last_name,u.profile_picture_uri FROM acd_messages m
    LEFT JOIN users u ON m.sender_role='agent' AND u.id=m.sender_id
    WHERE m.conversation_id=$1 AND NOT(m.sender_role='system' AND m.sender_id='widget-ai' AND m.client_id='ai_greeting')
    ORDER BY m.seq`,[session.conversation_id])).rows.map(message=>({
      id:message.sender_role==="customer"||message.sender_id==="widget-ai"?message.client_id:message.id,
      role:message.sender_role==="customer"?"user":message.sender_role==="agent"?"human":message.sender_id==="widget-ai"?"assistant":"system",
      content:message.body,createdAt:message.created_at,deliveryStatus:"delivered",
      attachments:attachments.filter(file=>file.message_id===message.id).map(file=>({id:file.id,filename:file.name,mime:file.content_type,size:file.byte_size,
        url:`/api/widget-sessions/attachments/${file.id}?access=${encodeURIComponent(attachmentAccessToken({attachmentId:file.id,sessionId:session.id}))}`})),
      ...(message.sender_role==="agent"?{agentName:[message.first_name,message.last_name].filter(Boolean).join(" ")||"Agent",
        agentAvatarUrl:session.config.avatars.human.useAgentProfilePicture?avatarUri(message.profile_picture_uri):null}:{}),
    }));
  const decision=evaluateWidgetDecisions(session.config,work.attributes?.context||{});
  return {runtimeKind:"human",greeting:work.attributes?.handoff?session.greeting:decision.config.content.welcomeMessage,messages,handoff:{
    status:work.conversation_state==="closed"?"disconnected":assignment?.state==="active"?"connected":offer?"assigned":"waiting",
    queueName:queue?.name||"Support",agentName:agent?[agent.first_name,agent.last_name].filter(Boolean).join(" ")||"Agent":null,
    agentAssigned:Boolean(agent),agentConnected:Boolean(assignment),
    agentTypingUntil:assignment?.state==="active"?assignment.typing_until||null:null,
  }};
}

export async function startWidgetSession(pool, options) {
  const { initializeAi, initializeVideo, ...result } = await prepareWidgetSession(pool, options);
  if (initializeVideo) {
    const { initializeVideoWidgetSession } = await import("./video-sessions.js");
    return initializeVideoWidgetSession(pool, result.sessionToken, options.rooms ? { rooms: options.rooms } : {});
  }
  if (!initializeAi) return result;
  // The durable starting session owns initialization. No database connection or
  // widget lock survives across provider I/O; retries read that same session.
  const { initializeAiWidgetSession } = await import("./ai-sessions.js");
  return initializeAiWidgetSession(pool, result.sessionToken, options.provider);
}

async function prepareWidgetSession(pool,{publicId,bootstrapToken,sessionToken,clientKey,admissionKey="unattributed",context={},channel="messaging"}){
  let claims;
  try{claims=verifyWidgetBootstrapToken(bootstrapToken,{publicId});}catch{throw fail("Bootstrap expired; reopen the widget",401);}
  if(typeof clientKey!=="string"||clientKey.length<16||clientKey.length>100)throw fail("Session request ID is required");
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    // Session creation, retries and the first queued work item share one commit.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,741902))",[`${publicId}:${claims.org}:${clientKey}`]);
    await tx.query("SELECT id FROM cc_widgets WHERE public_id=$1 FOR UPDATE",[publicId]);
    const widget=await getPublishedWidget(tx,publicId);
    if(!widget||widget.revision_id!==claims.rid||!isWidgetSessionOriginAllowed(claims.org,widget.config.allowedOrigins))throw fail("Widget publication changed or origin is no longer allowed",403);
    if (!["voice", "messaging", "video"].includes(channel)) throw fail("Channel unavailable");
    if(sessionToken){
      try{
        const resumed=await getWidgetSession(tx,sessionToken);
        if(resumed.widget_id===widget.id&&resumed.origin===claims.org && channelForRuntime(resumed.runtime_kind) === channel){
          const state=await readWidgetConversation(tx,resumed);
          if(state.handoff?.status!=="disconnected"){
            await tx.query("COMMIT");return {sessionToken,session:{id:resumed.id},...state};
          }
        }
      }catch(error){if(!error.status)throw error;}
    }
    const existing=(await tx.query("SELECT id FROM cc_widget_sessions WHERE widget_id=$1 AND origin=$2 AND client_key=$3",[widget.id,claims.org,clientKey])).rows[0];
    if(existing){
      const token=widgetSessionToken(existing.id);const session=await getWidgetSession(tx,token);
      if (channelForRuntime(session.runtime_kind) !== channel) throw fail("Session channel does not match",409);
      const state=await readWidgetConversation(tx,session);await tx.query("COMMIT");return {sessionToken:token,session:{id:session.id},...state};
    }
    const count=(await tx.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE admission_key=$2)::int AS client
      FROM cc_widget_sessions WHERE widget_id=$1 AND created_at>now()-interval '1 minute'`,[widget.id,admissionKey])).rows[0];
    if(count.client>=10 || count.total>=600)throw fail("Too many new conversations; please try again shortly",429);
    if(!context||typeof context!=="object"||Array.isArray(context)||JSON.stringify(context).length>16000)throw fail("Invalid page context");
    const decision=evaluateWidgetDecisions(widget.config,context);
    if (!decision.visible || !decision.config.channels[channel].enabled) throw fail("Channel is not available for this page",403);
    if (channel === "video") {
      const { createVideoWidgetSession } = await import("./video-sessions.js");
      const result = await createVideoWidgetSession(tx, { widget, decision, claims, clientKey, admissionKey, context });
      await tx.query("COMMIT");
      return { ...result, initializeVideo: true };
    }
    const runtimeKind = channel === "voice" ? "ai_voice" : decision.config.channels.messaging.assistantId ? "ai_chat" : "human";
    if (runtimeKind !== "human") {
      const { createAiWidgetSession } = await import("./ai-sessions.js");
      const result = await createAiWidgetSession(tx, { widget, decision, claims, clientKey, admissionKey, context, runtimeKind });
      await tx.query("COMMIT");
      return { ...result, initializeAi: runtimeKind === "ai_chat" };
    }
    const work=await createChatWork(tx,{queueId:decision.config.channels.messaging.routing.queueId,
      customerName:decision.matchedRule?.actions.some(action=>action.type==="customer-label")?decision.customerLabel:String(context["customer.name"]||context.customer_name||"Website visitor"),
      attributes:{widget_id:widget.id,widget_revision_id:widget.revision_id,context,origin:claims.org}});
    const id=randomUUID(),token=widgetSessionToken(id);
    await tx.query(`INSERT INTO cc_widget_sessions(id,token_hash,widget_id,revision_id,conversation_id,origin,client_key,expires_at,admission_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text||' minutes')::interval,$9)`,[id,hashSessionToken(token),widget.id,widget.revision_id,work.conversation_id,claims.org,clientKey,ttl(widget.config),admissionKey]);
    const session=await getWidgetSession(tx,token);const state=await readWidgetConversation(tx,session);
    await tx.query("COMMIT");
    return {sessionToken:token,greeting:decision.config.content.welcomeMessage||"",...state};
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}

export async function actAsWidgetCustomer(pool,{token,action,content,messageId,typing,provider}){
  const initialSession = await getWidgetSession(pool,token);
  if(initialSession.runtime_kind !== "human") return (await import("./ai-sessions.js")).actAsAiWidgetCustomer(pool,{session:initialSession,token,action,content,messageId,typing,provider});
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    let session=await getWidgetSession(tx,token);
    const work=(await tx.query("SELECT * FROM acd_work_items WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[session.conversation_id])).rows[0];
    session=await getWidgetSession(tx,token,{lock:true});
    const conversation=(await tx.query("SELECT state FROM acd_conversations WHERE id=$1",[session.conversation_id])).rows[0];
    if(action!=="disconnect"&&conversation.state!=="open")throw fail("Conversation has ended",409);
    if(action==="send"){
      const recent=(await tx.query(`SELECT count(*)::int AS n FROM acd_messages WHERE conversation_id=$1
        AND sender_role='customer' AND created_at>now()-interval '1 minute'`,[session.conversation_id])).rows[0].n;
      if(recent>=60)throw fail("Please wait before sending another message",429);
      await appendTextMessage(tx,{work,senderRole:"customer",senderId:session.id,clientId:messageId,body:content});
      await tx.query("UPDATE cc_widget_sessions SET last_seen_at=now(),expires_at=now()+($2::text||' minutes')::interval WHERE id=$1",[session.id,ttl(session.config)]);
    }else if(action==="typing"){
      await tx.query("UPDATE cc_widget_sessions SET typing_until=CASE WHEN $2 THEN now()+interval '6 seconds' ELSE NULL END WHERE id=$1",[session.id,typing===true]);
    }else if(action==="disconnect")await endCustomerChat(tx,work);
    else throw fail("Unknown widget action");
    const state=await readWidgetConversation(tx,session);await tx.query("COMMIT");return state;
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
