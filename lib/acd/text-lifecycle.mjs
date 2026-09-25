import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";
import { applyTransition, closeOpenSegment, createWorkItem, openSegment } from "./lifecycle.mjs";
import { promoteReservation, releaseReservation, resolveOffer } from "./reservations.mjs";
import { defineSaga, driveSaga, startSaga } from "./saga-engine.mjs";
import { readEffectiveChannelPolicy } from "./utilization.mjs";
import { loadAgentLifecycleSettings } from "./agent-lifecycle-settings.mjs";
import { setManualAgentStatusInTransaction, setWorkflowState } from "./agent-state.mjs";
import { NATIVE_LIFECYCLE_CHANNELS, channelDefinition } from "./channel-registry.mjs";

export const NATIVE_TEXT_PROVIDER = Object.freeze({
  name: "native-text",
  send() { throw new Error("Native text lifecycle must not issue telephony commands"); },
});
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export async function createChatWork(db, { conversationId = randomUUID(), ...options }) {
  const queue = await chatQueue(db, options.queueId);
  await db.query(`INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'chat',$2,$3::jsonb)`,
    [conversationId, String(options.customerName || "Website visitor").slice(0,120), JSON.stringify(options.attributes || {})]);
  return queueValidatedChatConversation(db, { conversationId, ...options }, queue);
}

async function chatQueue(db, queueId) {
  const queue = (await db.query(`SELECT q.* FROM cc_queues q JOIN cc_queue_channels c
    ON c.queue_id=q.id AND c.channel='chat' AND c.enabled=true WHERE q.id=$1 AND q.enabled=true`, [queueId])).rows[0];
  if (!queue) throw fail("This queue is not accepting chat", 503);
  return queue;
}

// Caller owns the transaction. AI handoff queues the existing conversation,
// preserving its identity and transcript instead of creating a second thread.
export async function queueChatConversation(db, options) {
  return queueValidatedChatConversation(db, options, await chatQueue(db, options.queueId));
}

async function queueValidatedChatConversation(db, { conversationId, queueId, customerName = "Website visitor", attributes = {}, actor = "widget" }, queue) {
  const conversation = await db.query(`UPDATE acd_conversations SET customer_name=$2,attributes=attributes||$3::jsonb
    WHERE id=$1 AND channel='chat' AND state='open' RETURNING id`,
    [conversationId, String(customerName).slice(0,120), JSON.stringify(attributes)]);
  if (!conversation.rowCount) throw fail("Chat conversation has ended");
  const work = await createWorkItem(db, { channel: "chat", direction: "inbound", queueId, conversationId,
    customerAddress: String(customerName).slice(0,120), requiredSkills: queue.skill_requirements || {},
    attributes, actor });
  await applyTransition(db, { workItemId: work.id, to: "queued", eventType: "work_item_queued",
    patch: { enqueuedAt: new Date().toISOString() }, actor });
  await openSegment(db, { workItemId: work.id, kind: "queue_wait", queueId });
  return { ...work, conversation_id: conversationId };
}

export async function startTextOffer(db, data) {
  const started = await startSaga(db, { type: "text_offer", workItemId: data.workItemId,
    conflictKey: "text_offer", data, deadlineMs: data.offerDeadlineMs });
  await db.query("UPDATE acd_reservations SET owner_saga_id=$2 WHERE id=$1", [data.reservationId,started.sagaId]);
  return started;
}

export async function cancelTextOffer(db, offer, reason, state = "cancelled") {
  const work = (await db.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE", [offer.work_item_id])).rows[0];
  const current = (await db.query("SELECT * FROM acd_offers WHERE id=$1 FOR UPDATE", [offer.id])).rows[0];
  if (!current || !["created","ringing"].includes(current.state)) return false;
  await resolveOffer(db, offer.id, state, { reason, actor: "text" });
  const reservations = (await db.query(`SELECT id FROM acd_reservations WHERE work_item_id=$1 AND agent_id=$2
    AND channel = ANY($3::text[]) AND state IN ('reserved','ringing')`, [work.id,offer.agent_id,NATIVE_LIFECYCLE_CHANNELS])).rows;
  for (const row of reservations) await releaseReservation(db, row.id, reason, { actor: "text" });
  if (work.state === "offered") await applyTransition(db, { workItemId: work.id, to: "queued",
    eventType: "work_item_requeued", actor: "text", payload: { reason, agent_id: offer.agent_id } });
  return true;
}

defineSaga("text_offer", {
  initialStep: "waiting",
  steps: {
    waiting: {
      deadlineMs: ctx => ctx.data.offerDeadlineMs || 30000,
      onDeadline: "expire",
      async run(tx, ctx) {
        const offer = (await tx.query("SELECT state FROM acd_offers WHERE id=$1", [ctx.data.offerId])).rows[0];
        return !offer || !["created","ringing"].includes(offer.state) ? "succeeded" : null;
      },
    },
    expire: {
      async run(tx, ctx) {
        const offer = (await tx.query("SELECT * FROM acd_offers WHERE id=$1", [ctx.data.offerId])).rows[0];
        if (offer) await cancelTextOffer(tx, offer, "answer_timeout", "no_answer");
        return "succeeded";
      },
    },
  },
});

// Revalidate against global occupied slots, including active work and earlier
// pending offers. Deterministically keep the oldest offers that still fit.
export async function revalidateTextOffers(db, { scope, id }) {
  const offers = (await db.query(`SELECT o.*,w.queue_id,w.channel FROM acd_offers o JOIN acd_work_items w ON w.id=o.work_item_id
    WHERE w.channel = ANY($3::text[]) AND o.state IN ('created','ringing')
      AND ($1='agent' AND o.agent_id=$2 OR $1='queue' AND w.queue_id=$2)
    ORDER BY o.created_at DESC,o.id`, [scope,id,NATIVE_LIFECYCLE_CHANNELS])).rows;
  let cancelled = 0;
  const policies = new Map();
  for (const offer of offers) {
    const policy = await readEffectiveChannelPolicy(db, { agentId: offer.agent_id, queueId: offer.queue_id, channel: offer.channel });
    policies.set(offer.id,policy);
    await db.query("SELECT agent_id FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [offer.agent_id]);
    await db.query(`UPDATE acd_reservations SET weight=$3 WHERE work_item_id=$1 AND agent_id=$2
      AND state IN ('reserved','ringing') AND channel = ANY($4::text[])`, [offer.work_item_id,offer.agent_id,policy.weight,NATIVE_LIFECYCLE_CHANNELS]);
  }
  for (const offer of offers) {
    const policy=policies.get(offer.id);
    const occ = (await db.query(`SELECT COUNT(*) FILTER(WHERE channel=$2)::int AS count,COALESCE(SUM(weight),0)::float AS weight
      FROM acd_reservations WHERE agent_id=$1 AND state<>'released'
        AND (state='active' OR owner_saga_id IS NOT NULL OR lease_expires_at>now())`, [offer.agent_id,offer.channel])).rows[0];
    const budget = (await db.query("SELECT capacity FROM acd_agent_state WHERE agent_id=$1", [offer.agent_id])).rows[0]?.capacity;
    if (!policy.enabled || occ.count > policy.maxConcurrent || occ.weight > Number(budget)+0.00001) {
      if (await cancelTextOffer(db, offer, "utilization_changed")) cancelled++;
    }
  }
  return cancelled;
}

export async function appendTextMessage(db, { work, senderRole, senderId, clientId, body, allowEmpty=false }) {
  if (typeof body !== "string" || (!allowEmpty&&!body.trim()) || body.length > 20000 || typeof clientId !== "string" || !clientId || clientId.length > 100) {
    throw fail("A message and a client message ID are required (maximum 20,000 characters)", 400);
  }
  const existing = (await db.query(`SELECT * FROM acd_messages WHERE conversation_id=$1 AND sender_role=$2 AND sender_id=$3 AND client_id=$4`,
    [work.conversation_id,senderRole,senderId,clientId])).rows[0];
  if (existing) {
    if (existing.body !== body.trim()) throw fail("Message ID was already used for different content");
    return existing;
  }
  const message = (await db.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(),work.conversation_id,work.id,senderRole,senderId,clientId,body.trim()])).rows[0];
  // Both sides' messages (including attachments) extend business inactivity.
  // Callers lock the work item before touching its visitor session.
  await db.query(`UPDATE cc_widget_sessions s SET typing_until=NULL,last_seen_at=now(),expires_at=now()+
    (GREATEST(1,LEAST(1440,COALESCE((r.config#>>'{behavior,inactivityMinutes}')::int,30)))::text||' minutes')::interval
    FROM cc_widget_revisions r WHERE s.revision_id=r.id AND s.conversation_id=$1`,[work.conversation_id]);
  if(senderRole==="agent")await db.query("UPDATE acd_text_assignments SET typing_until=NULL WHERE work_item_id=$1 AND agent_id=$2",[work.id,senderId]);
  await appendEvent(db, { workItemId: work.id, agentId: senderRole === "agent" ? senderId : null,
    type: "text_message_created", actor: senderRole, payload: { message_id: message.id, conversation_id: work.conversation_id, sender_role: senderRole } });
  return message;
}

export async function beginWrapup(db, work, assignment, actor, { outcome = "completed" } = {}) {
  if (assignment.state !== "active") return;
  const settings = await loadAgentLifecycleSettings(db);
  const pending=(await db.query(`UPDATE acd_text_assignments SET state='wrapup',typing_until=NULL,
    wrapup_deadline_at=now()+($2::text || ' seconds')::interval WHERE reservation_id=$1
    RETURNING wrapup_deadline_at`, [assignment.reservation_id,settings.wrapup_timeout_seconds])).rows[0];
  await closeOpenSegment(db, work.id, { outcome });
  // A transfer ends only this agent's handling segment. The conversation and
  // destination assignment continue independently of the source disposition.
  // Chat and video conversations live and die with the visitor session.
  if (["chat", "video"].includes(work.channel) && outcome !== "transferred") await db.query("UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id=$1 AND state='open'", [work.conversation_id]);
  await db.query("UPDATE acd_work_items SET version=version+1 WHERE id=$1", [work.id]);
  await setWorkflowState(db, assignment.agent_id, "wrapup", {
    workItemId: work.id, deadlineAt: pending.wrapup_deadline_at, actor, reason: `${work.channel}_${outcome}`,
  });
  await appendEvent(db, { workItemId: work.id, agentId: assignment.agent_id, actor,
    type: "text_wrapup_started", payload: { segment_id: assignment.segment_id, reservation_id: assignment.reservation_id, outcome, timeout_seconds: settings.wrapup_timeout_seconds } });
}

async function finishWrapup(db, work, assignment, codeId, actor, nextManualStatus = null) {
  if (assignment.state !== "wrapup") throw fail("This interaction is not in wrap-up");
  const agent=(await db.query("SELECT * FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE",[assignment.agent_id])).rows[0];
  const ownsCurrentWrapup=agent?.workflow_state==="wrapup" && String(agent.workflow_work_item_id)===String(work.id);
  const segment=(await db.query(`UPDATE acd_segments SET
    wrapup_code_id=CASE WHEN $2::text='auto_timeout' THEN COALESCE(wrapup_code_id,$2) ELSE COALESCE($2,wrapup_code_id) END,
    wrapup_ended_at=COALESCE(wrapup_ended_at,now()) WHERE id=$1 RETURNING wrapup_code_id,outcome`, [assignment.segment_id,codeId])).rows[0];
  const transferred = segment.outcome === "transferred";
  await db.query("UPDATE acd_text_assignments SET state='completed',completed_at=now() WHERE reservation_id=$1", [assignment.reservation_id]);
  if (!transferred) await resolveOffer(db, (await db.query(`SELECT id FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2 AND state='accepted'`, [work.id,assignment.agent_id])).rows[0]?.id,
    "cancelled", { reason: "completed", actor });
  if(nextManualStatus && ownsCurrentWrapup)await setManualAgentStatusInTransaction(db,{
    agentId:assignment.agent_id,status:nextManualStatus,actor,
  });
  const released = await releaseReservation(db, assignment.reservation_id, "wrapup_completed", { actor });
  // Transfer already released this handling reservation. Recompute only the
  // source workflow; never release the destination or complete its work item.
  if (!released && ownsCurrentWrapup) await setWorkflowState(db, assignment.agent_id, "idle", {
    workItemId: work.id, actor, reason: "wrapup_completed",
  });
  if (!transferred) {
    await applyTransition(db, { workItemId: work.id, to: "completed", eventType: "work_item_completed", actor,
      payload: { agent_id: assignment.agent_id, wrapup_code_id: segment.wrapup_code_id } });
    if(work.channel==='email')await db.query(`UPDATE cc_email_received SET route_after=now() WHERE mailbox_id IN
      (SELECT mailbox_id FROM cc_email_threads WHERE conversation_id=$1) AND processed_at IS NULL`,[work.conversation_id]);
    if(work.channel==='sms')await db.query(`UPDATE cc_sms_received r SET route_after=now() FROM cc_sms_threads t
      WHERE t.conversation_id=$1 AND r.number_id=t.number_id AND r.customer_address=t.customer_address AND r.processed_at IS NULL`,[work.conversation_id]);
    if(work.channel==='whatsapp')await db.query(`UPDATE cc_whatsapp_received r SET route_after=now() FROM cc_whatsapp_threads t
      WHERE t.conversation_id=$1 AND r.number_id=t.number_id AND r.customer_address=t.customer_address AND r.processed_at IS NULL AND r.media_state<>'pending'`,[work.conversation_id]);
  }
  await appendEvent(db,{workItemId:work.id,agentId:assignment.agent_id,type:"wrapup_completed",actor,
    payload:{segment_id:assignment.segment_id,wrapup_code_id:segment.wrapup_code_id,agent_state_released:ownsCurrentWrapup}});
  return {completed:true,agentId:String(assignment.agent_id),alreadyCompleted:false,agentStateReleased:ownsCurrentWrapup};
}

// Shared WrapupCodesSheet uses the same completion endpoint for voice and
// chat. Complete the text assignment, reservation and workflow atomically.
export async function completeTextWrapup(pool,{workItemId,transactionClient=null,expectedAgentId=null,segmentId=null,wrapupCodeId=null,nextManualStatus=null,actor="agent:wrapup"}){
  const db=transactionClient||await pool.connect(),manageTransaction=!transactionClient;
  try{
    if(manageTransaction)await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(741901,5)");
    const work=(await db.query("SELECT * FROM acd_work_items WHERE id=$1 AND channel = ANY($2::text[]) FOR UPDATE",[workItemId,NATIVE_LIFECYCLE_CHANNELS])).rows[0];
    const assignment=work?(await db.query(`SELECT * FROM acd_text_assignments WHERE work_item_id=$1
      AND ($2::text IS NULL OR agent_id=$2) AND ($3::uuid IS NULL OR segment_id=$3)
      ORDER BY (state='wrapup') DESC,(state='active') DESC,wrapup_deadline_at,completed_at DESC NULLS FIRST
      LIMIT 1 FOR UPDATE`,[workItemId,expectedAgentId,segmentId])).rows[0]:null;
    let result;
    if(!work)result={completed:false,reason:"work_item_not_found"};
    else if(!assignment)result={completed:false,reason:"agent_segment_not_found"};
    else if(assignment.state==="completed")result={completed:true,agentId:String(assignment.agent_id),alreadyCompleted:true,agentStateReleased:false};
    else if(assignment.state!=="wrapup")result={completed:false,reason:"work_item_not_terminal"};
    else result=await finishWrapup(db,work,assignment,wrapupCodeId,actor,nextManualStatus);
    if(manageTransaction)await db.query("COMMIT");
    return result;
  }catch(error){if(manageTransaction)await db.query("ROLLBACK");throw error;}
  finally{if(manageTransaction)db.release();}
}

export async function actOnTextWork(pool, { workItemId, agentId, commandId, expectedVersion, action, channel = "chat", ...data }, {attachments=[],beforeSend,sendHandler,sendProvider}={}) {
  if (typeof commandId !== "string" || !commandId || commandId.length>100 || expectedVersion == null) throw fail("Command ID and interaction version are required",400);
  // Attachment bytes enter only through the trusted multipart handler. Bind
  // retries to their validated metadata and hashes, never serialize raw BYTEA.
  const hash = createHash("sha256").update(JSON.stringify({ action, expectedVersion, data,
    ...(attachments.length?{attachments:attachments.map(({bytes:_bytes,...file})=>file)}:{}) })).digest("hex");
  const tx = await pool.connect();
  let sagaId, sendSagaId, committed;
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
    const work = (await tx.query("SELECT * FROM acd_work_items WHERE id=$1 AND channel = ANY($2::text[]) FOR UPDATE", [workItemId,NATIVE_LIFECYCLE_CHANNELS])).rows[0];
    if (!work || work.channel !== channel) throw fail("Interaction not found",404);
    const previous = (await tx.query("SELECT * FROM acd_text_commands WHERE work_item_id=$1 AND actor_id=$2 AND command_id=$3", [workItemId,agentId,commandId])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) throw fail("Command ID was already used for another action");
      await tx.query("COMMIT"); return previous.result;
    }
    const offer = (await tx.query(`SELECT * FROM acd_offers WHERE work_item_id=$1 AND agent_id=$2
      AND state IN ('created','ringing','accepted') ORDER BY generation DESC LIMIT 1 FOR UPDATE`, [workItemId,agentId])).rows[0];
    const assignment = (await tx.query(`SELECT * FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2
      AND state<>'completed' FOR UPDATE`, [workItemId,agentId])).rows[0];
    if (!offer && !assignment) throw fail("This interaction belongs to another agent",403);
    if (assignment?.state === "wrapup" && action !== "wrapup") throw fail("This handling segment has ended",403);
    if (String(expectedVersion) !== String(work.version)) throw fail("Interaction changed; refresh and retry");
    const agent=(await tx.query("SELECT * FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [agentId])).rows[0];
    let result = { ok: true };
    if (action === "accept" || action === "reject") {
      if (work.state !== "offered" || !offer || !["created","ringing"].includes(offer.state) || data.offerId !== offer.id) throw fail("Offer is no longer available");
      if (new Date(offer.deadline_at).getTime() <= Date.now()) throw fail("Offer has expired");
      const reservation = (await tx.query(`SELECT * FROM acd_reservations WHERE work_item_id=$1 AND agent_id=$2 AND state IN ('reserved','ringing')`, [workItemId,agentId])).rows[0];
      if (!reservation) throw fail("Reservation is no longer available");
      sagaId = reservation.owner_saga_id;
      if (action === "reject") await cancelTextOffer(tx, offer, "agent_rejected", "rejected");
      else {
        if(agent.workflow_state==="wrapup")throw fail("Complete wrap-up before accepting another conversation");
        const policy = await readEffectiveChannelPolicy(tx, { agentId, queueId: work.queue_id, channel: work.channel });
        const ready = await tx.query(`SELECT 1 FROM acd_agent_sessions WHERE agent_id=$1 AND state='online' AND expires_at>now() AND capabilities->>$2='true'`, [agentId,work.channel]);
        const occupied = (await tx.query(`SELECT COUNT(*) FILTER(WHERE channel=$2)::int AS count,
          COALESCE(SUM(weight),0)::float AS weight,BOOL_OR(channel='voice') AS voice
          FROM acd_reservations WHERE agent_id=$1 AND state<>'released'
          AND (state='active' OR owner_saga_id IS NOT NULL OR lease_expires_at>now())`, [agentId,work.channel])).rows[0];
        const capacity = Number((await tx.query("SELECT capacity FROM acd_agent_state WHERE agent_id=$1", [agentId])).rows[0].capacity);
        if (!policy.enabled || !ready.rowCount || occupied.voice || occupied.count>policy.maxConcurrent
          || occupied.weight>Math.min(capacity,1)+0.00001) throw fail("This conversation is no longer available for this agent");
        await resolveOffer(tx, offer.id, "accepted", { actor: agentId });
        await closeOpenSegment(tx, workItemId, { outcome: "answered", answeredAt: new Date().toISOString() });
        const segment = await openSegment(tx, { workItemId, kind: "agent", queueId: work.queue_id, agentId, answeredAt: new Date().toISOString() });
        await promoteReservation(tx, { reservationId: reservation.id, to: "active", handlingSessionId: randomUUID(), actor: agentId });
        await tx.query(`INSERT INTO acd_text_assignments(reservation_id,work_item_id,agent_id,segment_id) VALUES($1,$2,$3,$4)`, [reservation.id,workItemId,agentId,segment.id]);
        await applyTransition(tx, { workItemId, to: "active", eventType: "text_accepted", actor: agentId, payload: { agent_id: agentId } });
      }
    } else if (action === "send") {
      if (assignment?.state !== "active") throw fail("Accept the conversation before replying");
      if (work.channel === "chat") {
        await beforeSend?.(tx,work);
        result.message = await appendTextMessage(tx, { work, senderRole: "agent", senderId: agentId, clientId: commandId, body: data.body,allowEmpty:attachments.length>0 });
        for(const file of attachments)await tx.query(`INSERT INTO acd_text_attachments(id,message_id,conversation_id,name,content_type,bytes,byte_size,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),result.message.id,work.conversation_id,file.name,file.content_type,file.bytes,file.byte_size,file.content_hash]);
      } else if (typeof sendHandler === "function") {
        // Provider-backed channels journal the send inside this transaction and
        // drive their durable saga after commit, exactly like the email adapter.
        const sent = await sendHandler(tx, { work, assignment, agentId, commandId, body: data.body, data, attachments });
        result.message = sent.message; result.status = sent.status; sendSagaId = sent.sagaIds || (sent.sagaId ? [sent.sagaId] : []);
        if (sent.messages) result.messages = sent.messages;
      } else throw fail("Use the email send operation",400);
      if (data.draftVersion != null) {
        const cleared = await tx.query(`UPDATE acd_text_drafts SET body='',version=version+1,updated_at=now()
          WHERE work_item_id=$1 AND agent_id=$2 AND version=$3 AND draft_scope=$4 RETURNING version`,[workItemId,agentId,data.draftVersion,data.draftScope||"legacy"]);
        if (cleared.rowCount) result.draftVersion = String(cleared.rows[0].version);
      }
    } else if (action === "disconnect" || (channelDefinition(work.channel).capabilities.deliveryEvidence && ["complete","wait"].includes(action))) {
      if(work.channel === "email") {
        const pending=await tx.query("SELECT 1 FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id WHERE m.work_item_id=$1 AND e.status IN ('queued','scheduled','ambiguous')",[work.id]);
        if(pending.rowCount)throw fail("Wait for pending email sends or cancel scheduled messages before completing");
        await tx.query("UPDATE cc_email_threads SET state=$2 WHERE conversation_id=$1",[work.conversation_id,action==='wait'?'waiting':'completed']);
      }
      if(work.channel === "sms") {
        const pending=await tx.query("SELECT 1 FROM cc_sms_messages s JOIN acd_messages m ON m.id=s.message_id WHERE m.work_item_id=$1 AND s.status='queued'",[work.id]);
        if(pending.rowCount)throw fail("Wait for the pending SMS send before completing");
        await tx.query("UPDATE cc_sms_threads SET state=$2 WHERE conversation_id=$1",[work.conversation_id,action==='wait'?'waiting':'completed']);
      }
      if(work.channel === "whatsapp") {
        const pending=await tx.query("SELECT 1 FROM cc_whatsapp_messages s JOIN acd_messages m ON m.id=s.message_id WHERE m.work_item_id=$1 AND s.status='queued'",[work.id]);
        if(pending.rowCount)throw fail("Wait for the pending WhatsApp send before completing");
        await tx.query("UPDATE cc_whatsapp_threads SET state=$2 WHERE conversation_id=$1",[work.conversation_id,action==='wait'?'waiting':'completed']);
      }
      if (assignment?.state !== "active") throw fail("Conversation is not active");
      await beginWrapup(tx, work, assignment, agentId);
    } else if (action === "wrapup") {
      if (!assignment) throw fail("Assignment not found");
      if (typeof data.codeId !== "string" || !data.codeId) throw fail("Select a wrap-up code",400);
      const valid = await tx.query(`SELECT 1 FROM cc_wrapup_codes c WHERE c.id=$1 AND c.is_active=true AND
        (NOT EXISTS(SELECT 1 FROM cc_queue_wrapup_codes WHERE queue_id=$2)
         OR EXISTS(SELECT 1 FROM cc_queue_wrapup_codes WHERE queue_id=$2 AND wrapup_code_id=c.id))`,
        [data.codeId,(await tx.query("SELECT queue_id FROM acd_segments WHERE id=$1",[assignment.segment_id])).rows[0].queue_id]);
      if (!valid.rowCount) throw fail("Invalid wrap-up code",400);
      if(data.nextStatus != null && data.nextStatus !== 'Break')throw fail('Unsupported post-wrap-up status',400);
      if(data.nextStatus)await setManualAgentStatusInTransaction(tx,{agentId,status:data.nextStatus,actor:agentId});
      await finishWrapup(tx, work, assignment, data.codeId, agentId);
    } else throw fail("Unknown messaging action",400);
    result.version = String((await tx.query("SELECT version FROM acd_work_items WHERE id=$1", [workItemId])).rows[0].version);
    await tx.query(`INSERT INTO acd_text_commands(work_item_id,actor_id,command_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`, [workItemId,agentId,commandId,hash,JSON.stringify(result)]);
    await tx.query("COMMIT");
    committed=result;
  } catch (error) { await tx.query("ROLLBACK"); throw error; }
  finally { tx.release(); }
  // Release the transaction client before acquiring the saga runner's client.
  // Its durable deadline worker also closes a settled offer after a restart.
  if(sagaId)await driveSaga(pool,sagaId,{provider:NATIVE_TEXT_PROVIDER}).catch(()=>undefined);
  for(const id of sendSagaId||[])if(sendProvider)await driveSaga(pool,id,{provider:sendProvider}).catch(()=>undefined);
  return committed;
}

export async function endCustomerChat(db, work) {
  if (work.terminal_at) return;
  const assignment = (await db.query(`SELECT a.* FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
    WHERE a.work_item_id=$1 AND a.state<>'completed' AND s.outcome IS DISTINCT FROM 'transferred'
    ORDER BY (a.state='active') DESC LIMIT 1 FOR UPDATE OF a`, [work.id])).rows[0];
  if (assignment) return beginWrapup(db, work, assignment, "customer");
  const offers = (await db.query("SELECT * FROM acd_offers WHERE work_item_id=$1 AND state IN ('created','ringing')", [work.id])).rows;
  for (const offer of offers) await cancelTextOffer(db, offer, "customer_left");
  await closeOpenSegment(db, work.id, { outcome: "abandoned" });
  await applyTransition(db, { workItemId: work.id, to: "abandoned", eventType: "text_customer_left", actor: "customer" });
  await db.query("UPDATE acd_conversations SET state='closed',closed_at=now() WHERE id=$1", [work.conversation_id]);
}

// Older transfers completed the text assignment but left its segment pending.
// Close only those proven completed transfers, preserving codes and the actual
// transfer time. Recompute workflow through Core so other work still owns it.
export async function repairTransferredTextWrapups(pool, { agentId = null, workItemId = null, actor = 'reconciler' } = {}) {
  const stale = (await pool.query(`SELECT a.reservation_id,a.work_item_id FROM acd_text_assignments a
    JOIN acd_segments s ON s.id=a.segment_id
    WHERE a.state='completed' AND s.outcome='transferred' AND s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NULL
      AND ($1::text IS NULL OR a.agent_id=$1) AND ($2::uuid IS NULL OR a.work_item_id=$2)
    ORDER BY s.ended_at LIMIT 100`, [agentId, workItemId])).rows;
  let repaired = 0;
  for (const row of stale) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(741901,5)');
      await db.query('SELECT id FROM acd_work_items WHERE id=$1 FOR UPDATE', [row.work_item_id]);
      const segment = (await db.query(`UPDATE acd_segments s SET wrapup_ended_at=s.ended_at,wrapup_deadline_at=NULL
        FROM acd_text_assignments a WHERE a.reservation_id=$1 AND a.segment_id=s.id
          AND a.state='completed' AND s.outcome='transferred' AND s.ended_at IS NOT NULL AND s.wrapup_ended_at IS NULL
        RETURNING s.id,s.agent_id`, [row.reservation_id])).rows[0];
      if (segment) {
        const agent = (await db.query('SELECT workflow_state,workflow_work_item_id FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE', [segment.agent_id])).rows[0];
        if (agent?.workflow_state === 'wrapup' && String(agent.workflow_work_item_id) === String(row.work_item_id)) {
          await setWorkflowState(db, segment.agent_id, 'idle', { workItemId: row.work_item_id, actor, reason: 'transferred_text_wrapup_repaired' });
        }
        await appendEvent(db, { workItemId: row.work_item_id, agentId: segment.agent_id, actor,
          type: 'reconciler_corrected', payload: { kind: 'transferred_text_wrapup_closed', segment_id: segment.id } });
        repaired++;
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  return repaired;
}

export async function sweepTextWrapups(pool) {
  await repairTransferredTextWrapups(pool);
  // Recover pre-sheet chat wrap-ups, and repair workflow projection after a
  // restart, without restarting their persisted timeout or releasing a slot.
  const recoverable=(await pool.query(`SELECT a.work_item_id,a.reservation_id FROM acd_text_assignments a
    JOIN acd_segments s ON s.id=a.segment_id JOIN acd_agent_state ast ON ast.agent_id=a.agent_id
    WHERE a.state='wrapup' AND s.wrapup_ended_at IS NULL
      AND (s.wrapup_deadline_at IS NULL OR ast.workflow_state<>'wrapup')
      AND NOT EXISTS (SELECT 1 FROM acd_reservations r WHERE r.agent_id=a.agent_id
        AND r.channel='voice' AND r.state<>'released'
        AND (r.state='active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at>now()))
    LIMIT 100`)).rows;
  for(const row of recoverable){
    const tx=await pool.connect();
    try{
      await tx.query("BEGIN");await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
      await tx.query("SELECT id FROM acd_work_items WHERE id=$1 FOR UPDATE",[row.work_item_id]);
      const pending=(await tx.query("SELECT * FROM acd_text_assignments WHERE reservation_id=$1 AND state='wrapup' FOR UPDATE",[row.reservation_id])).rows[0];
      if(pending)await setWorkflowState(tx,pending.agent_id,"wrapup",{
        workItemId:row.work_item_id,deadlineAt:pending.wrapup_deadline_at,actor:"reconciler",reason:"chat_wrapup_recovered",
      });
      await tx.query("COMMIT");
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  }
  const due = (await pool.query("SELECT work_item_id,reservation_id FROM acd_text_assignments WHERE state='wrapup' AND wrapup_deadline_at<=now() ORDER BY wrapup_deadline_at LIMIT 100")).rows;
  let count = 0;
  for (const row of due) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT pg_advisory_xact_lock(741901,5)");
      const work = (await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE", [row.work_item_id])).rows[0];
      const assignment = (await tx.query("SELECT * FROM acd_text_assignments WHERE reservation_id=$1 AND state='wrapup' AND wrapup_deadline_at<=now() FOR UPDATE", [row.reservation_id])).rows[0];
      if (assignment) { await finishWrapup(tx, work, assignment, "auto_timeout", "reconciler"); count++; }
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  return count;
}

/** Expiry is a durable lifecycle event, not merely an expired browser token. */
export async function sweepTextInactivity(pool) {
  await pool.query(`WITH expired AS (
    UPDATE cc_widget_sessions SET runtime_state='completed'
    WHERE runtime_kind NOT IN ('human','video') AND runtime_state IN ('active','starting') AND expires_at<=now()
    RETURNING conversation_id
  ) UPDATE acd_conversations SET state='closed',closed_at=now()
    WHERE id IN (SELECT conversation_id FROM expired) AND state='open'`);
  const due = (await pool.query(`SELECT w.id FROM acd_work_items w
    JOIN acd_conversations c ON c.id=w.conversation_id AND c.state='open'
    JOIN cc_widget_sessions s ON s.conversation_id=c.id
    WHERE w.channel IN ('chat','video') AND s.expires_at<=now()
    ORDER BY s.expires_at LIMIT 100`)).rows;
  let count = 0;
  for (const row of due) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const work = (await tx.query("SELECT * FROM acd_work_items WHERE id=$1 FOR UPDATE",[row.id])).rows[0];
      const expired = await tx.query(`SELECT 1 FROM cc_widget_sessions s
        JOIN acd_conversations c ON c.id=s.conversation_id AND c.state='open'
        WHERE s.conversation_id=$1 AND s.expires_at<=now() FOR UPDATE OF s`,[work.conversation_id]);
      if (expired.rowCount) {
        await endCustomerChat(tx,work);
        await appendEvent(tx,{workItemId:work.id,type:"text_session_expired",actor:"reconciler",payload:{conversation_id:work.conversation_id}});
        count++;
      }
      await tx.query("COMMIT");
    } catch(error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  return count;
}
