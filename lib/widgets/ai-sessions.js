import { randomUUID } from "node:crypto";
import { hashSessionToken, widgetSessionToken } from "./session-tokens.js";
import { getWidgetSession, readWidgetConversation, actAsWidgetCustomer } from "./sessions.js";
import { widgetHandoffContext } from "./handoff-context.js";
import { widgetAiProvider } from "./ai-provider.js";
import { interpolateDynamicVariables, widgetDynamicVariables } from "./dynamic-variables.js";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const minutes = session => Math.max(5, Number(session.config.behavior.inactivityMinutes) || 30);

export async function readAiWidgetConversation(db, session) {
  const commands = session.runtime_kind === "ai_chat" ? (await db.query(
    "SELECT * FROM cc_widget_ai_commands WHERE session_id=$1 ORDER BY created_at,client_id", [session.id],
  )).rows : [];
  const closed = ["completed", "failed"].includes(session.runtime_state);
  const handoff=(await db.query("SELECT status,queue_name,work_item_id FROM cc_widget_handoffs WHERE session_id=$1",[session.id])).rows[0];
  if(handoff?.work_item_id)return readWidgetConversation(db,{...session,runtime_kind:"human"});
  const messages = commands.filter(c => c.state !== "rejected").flatMap(c => [
    { id: c.client_id, role: "user", content: c.content, createdAt: c.created_at,
      deliveryStatus: c.state === "completed" ? "delivered" : "pending", attachments: [] },
    ...(c.state === "completed" && c.reply ? [{ id: `ai_${c.client_id}`, role: "assistant", content: c.reply,
      createdAt: c.updated_at, deliveryStatus: "delivered", attachments: [] }] : []),
  ]);
  return { runtimeKind: session.runtime_kind, greeting: session.greeting, messages,
    handoff: closed ? { status: "disconnected" } : handoff?.status==="failed"?{status:"failed",queueName:handoff.queue_name}:null,
    session: { id: session.id, status: session.runtime_state },
    ...(session.runtime_state === "starting" || commands.some(c => ["processing", "unknown"].includes(c.state)) ? { pendingReply: true } : {}),
  };
}

export async function createAiWidgetSession(tx, { widget, decision, claims, clientKey, admissionKey, context, runtimeKind }) {
  const id = randomUUID(), conversationId = randomUUID(), token = widgetSessionToken(id);
  const assistantId = runtimeKind === "ai_voice" ? decision.config.channels.voice.assistantId : decision.config.channels.messaging.assistantId;
  if (!assistantId) throw fail("Select an AI assistant before starting this channel");
  const state = "starting";
  await tx.query(`INSERT INTO acd_conversations(id,channel,attributes) VALUES($1,$2,$3::jsonb)`,
    [conversationId, runtimeKind === "ai_voice" ? "voice" : "chat", JSON.stringify({ widget_id: widget.id, runtime_kind: runtimeKind, assistant_id: assistantId })]);
  await tx.query(`INSERT INTO cc_widget_sessions(id,token_hash,widget_id,revision_id,conversation_id,origin,client_key,expires_at,
      runtime_kind,assistant_id,context,runtime_state,admission_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text||' minutes')::interval,$9,$10,$11::jsonb,$12,$13)`,
    [id,hashSessionToken(token),widget.id,widget.revision_id,conversationId,claims.org,clientKey,
      runtimeKind === "ai_chat" ? 2 : minutes({config:decision.config}),runtimeKind,assistantId,JSON.stringify(context),state,admissionKey]);
  const session = await getWidgetSession(tx, token);
  return { sessionToken: token, ...await readAiWidgetConversation(tx, session) };
}

// Only the creator of the committed session may call this. Failed or ambiguous
// initialization remains durable so retrying cannot create another AI session.
export async function initializeAiWidgetSession(pool, token, provider = widgetAiProvider) {
  const session = await getWidgetSession(pool, token);
  try {
    session.handoffContext=await widgetHandoffContext(pool,session);
    const providerId = await provider.createConversation(session);
    session.provider_conversation_id=providerId;
    await pool.query("UPDATE cc_widget_sessions SET provider_conversation_id=$2 WHERE id=$1",[session.id,providerId]);
    if(provider.configureConversation)await provider.configureConversation(session);
    const greeting = interpolateDynamicVariables(await provider.greeting(session.assistant_id).catch(() => ""), widgetDynamicVariables(session.context));
    await pool.query(`UPDATE cc_widget_sessions SET provider_conversation_id=$2,greeting=$3,
      runtime_state=CASE WHEN runtime_state='starting' THEN 'active' ELSE runtime_state END,
      expires_at=CASE WHEN runtime_state='starting' THEN now()+($4::text||' minutes')::interval ELSE expires_at END
      WHERE id=$1`, [session.id,providerId,greeting,minutes(session)]);
  } catch (error) {
    await pool.query(`WITH failed AS (
      UPDATE cc_widget_sessions SET runtime_state='failed' WHERE id=$1 AND runtime_state='starting'
      RETURNING conversation_id
    ) UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id IN (SELECT conversation_id FROM failed)`, [session.id]);
    throw error;
  }
  return { sessionToken: token, ...await readAiWidgetConversation(pool, await getWidgetSession(pool, token)) };
}

export async function actAsAiWidgetCustomer(pool, { token, action, content, messageId, typing, provider = widgetAiProvider }) {
  const tx = await pool.connect();
  let session, shouldSend = false;
  try {
    await tx.query("BEGIN");
    session = await getWidgetSession(tx, token, {lock:true});
    if (!["ai_chat","human"].includes(session.runtime_kind)) throw fail("This operation requires a messaging session");
    if (session.runtime_kind === "human") {
      // Handoff won the race after the caller's initial read. Release this
      // lock before native handling acquires work -> session locks.
    } else if (action === "disconnect") {
      await tx.query("UPDATE cc_widget_sessions SET runtime_state='completed' WHERE id=$1", [session.id]);
      await tx.query("UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id=$1", [session.conversation_id]);
    } else {
      if (session.runtime_state === "starting") throw fail("The assistant is still connecting",409);
      if (session.runtime_state !== "active") throw fail("Conversation has ended",409);
      if (action === "send") {
        if (typeof content !== "string" || !content.trim() || content.length > 20000
          || typeof messageId !== "string" || !messageId || messageId.length > 100) throw fail("Invalid message");
        const old = (await tx.query("SELECT * FROM cc_widget_ai_commands WHERE session_id=$1 AND client_id=$2", [session.id,messageId])).rows[0];
        if (old && old.content !== content) throw fail("Message ID already used for different content",409);
        if (!old || old.state === "rejected") {
          const pending = await tx.query("SELECT 1 FROM cc_widget_ai_commands WHERE session_id=$1 AND state IN ('processing','unknown')", [session.id]);
          if (pending.rowCount) throw fail("The previous AI reply is still being confirmed",409);
          const count = (await tx.query("SELECT count(*)::int AS n FROM cc_widget_ai_commands WHERE session_id=$1 AND created_at>now()-interval '1 minute'",[session.id])).rows[0].n;
          if (count >= 30) throw fail("Please wait before sending another message",429);
          await tx.query(`INSERT INTO cc_widget_ai_commands(session_id,client_id,content,state) VALUES($1,$2,$3,'processing')
            ON CONFLICT(session_id,client_id) DO UPDATE SET state='processing',updated_at=now()`, [session.id,messageId,content]);
          shouldSend = true;
        }
      } else if (action !== "typing") throw fail("Unknown messaging action");
      await tx.query("UPDATE cc_widget_sessions SET expires_at=now()+($2::text||' minutes')::interval,last_seen_at=now() WHERE id=$1", [session.id,minutes(session)]);
    }
    await tx.query("COMMIT");
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  if(session.runtime_kind==="human")return actAsWidgetCustomer(pool,{token,action,content,messageId,typing,provider});
  if (shouldSend) {
    try {
      const reply = await provider.send(session,content,messageId);
      await pool.query("UPDATE cc_widget_ai_commands SET state='completed',reply=$3,updated_at=now() WHERE session_id=$1 AND client_id=$2", [session.id,messageId,reply]);
    } catch (error) {
      // A timeout cannot prove that the provider rejected a message. Persist the
      // uncertain state so a browser retry never sends the same message twice.
      await pool.query("UPDATE cc_widget_ai_commands SET state=$3,updated_at=now() WHERE session_id=$1 AND client_id=$2", [session.id,messageId,error.ambiguous === false ? "rejected" : "unknown"]);
      session=await getWidgetSession(pool,token);
      if(session.runtime_kind!=="human")throw error;
    }
  }
  session = await getWidgetSession(pool,token);
  const result = await readWidgetConversation(pool,session);
  return { ...result, message: result.messages.find(m => m.id === `ai_${messageId}`) || null };
}

export async function updateWidgetVoiceState(pool, token, body = null) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    let session = await getWidgetSession(tx,token,{lock:true});
    if (session.runtime_kind !== "ai_voice") throw fail("Voice session required",409);
    if (body) {
      if (!["active","completed","failed"].includes(body.status)) throw fail("Invalid voice state");
      if (!["completed","failed"].includes(session.runtime_state)) {
        await tx.query("UPDATE cc_widget_sessions SET runtime_state=$2,last_seen_at=now() WHERE id=$1",[session.id,body.status]);
        if (body.status !== "active") await tx.query("UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id=$1",[session.conversation_id]);
      }
    }
    // Polls keep an active call alive; abandoned starts and terminal calls still expire.
    await tx.query(`UPDATE cc_widget_sessions SET expires_at=now()+($2::text||' minutes')::interval,last_seen_at=now()
      WHERE id=$1 AND runtime_state='active'`,[session.id,minutes(session)]);
    session = await getWidgetSession(tx,token);
    const state = await readAiWidgetConversation(tx,session);
    await tx.query("COMMIT");
    return state;
  } catch(error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
}
