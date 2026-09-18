import { randomUUID, createHash } from 'node:crypto';
import { persistWebhookEvent } from '../acd/inbox.mjs';
import { appendEvent } from '../acd/events.mjs';
import { createWorkItem, applyTransition, openSegment } from '../acd/lifecycle.mjs';
import { emailRequest, emailId, emailError, fetchEmailContent } from './provider.mjs';
import { normalizeInbound, classifyEmail, reduceDelivery, inboundFiles } from './policy.mjs';
import { retainEmailFile } from './private-storage.mjs';
import { applyMessagingDeliveryUpdate, markMessagingReplied } from '../outbound-dialer/messaging/execution.mjs';

export const emailEventKey = (mailboxId, id) => `email:${createHash('sha256').update(JSON.stringify([mailboxId,id])).digest('hex')}`;

// Recover missed delivery callbacks using recipient records, whose shape is
// different from the Events API and includes the durable recipient identity.
export async function syncEmailDeliveries(pool,{request=emailRequest}={}){
  const db=await pool.connect();let message;
  try{
    await db.query('BEGIN');
    message=(await db.query(`SELECT e.* FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id
      WHERE m.sender_role='agent' AND e.provider_message_id IS NOT NULL AND e.next_delivery_sync_at<=now()
        AND m.created_at>now()-interval '7 days' ORDER BY e.next_delivery_sync_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`)).rows[0];
    if(!message){await db.query('COMMIT');return false;}
    const params=new URLSearchParams({page_size:'100',...(message.delivery_cursor?{page_cursor:message.delivery_cursor}:{})});
    const result=await request(`/email_messages/${emailId(message.provider_message_id)}/recipients?${params}`);
    if(!Array.isArray(result.data))throw emailError('Invalid email recipient response',502);
    for(const recipient of result.data){
      const id=recipient.id||recipient.recipient_id,kind=recipient.kind||'to';
      if(!id||!recipient.status)continue;
      const timestamp=recipient.updated_at||recipient[`${recipient.status}_at`]||(['failed','bounced','expired','gw_reject','injection_timeout'].includes(recipient.status)?recipient.failed_at:null)||null;
      const evidence=recipient.error_evidence||{smtp_status:recipient.smtp_code,message:recipient.smtp_response};
      const payload={id:message.provider_message_id,recipient_id:id,[kind]:{email:kind==='bcc'?null:recipient.address||recipient.email},error_evidence:evidence};
      await persistWebhookEvent(db,{eventId:emailEventKey('recipient',JSON.stringify([message.provider_message_id,id,recipient.status,timestamp,evidence])),
        provider:'telnyx-email',eventType:`email.${recipient.status}`,occurredAt:timestamp||new Date().toISOString(),payload,sourceRoute:'email:recipient-sync'});
    }
    const cursor=result.meta?.page_cursor||result.meta?.next_cursor||null;
    if(cursor&&cursor===message.delivery_cursor)throw emailError('Email recipient cursor did not advance',502);
    await db.query(`UPDATE cc_email_messages SET delivery_cursor=$2,delivery_error=NULL,
      next_delivery_sync_at=now()+CASE WHEN $2::text IS NULL THEN interval '60 seconds' ELSE interval '1 second' END WHERE message_id=$1`,[message.message_id,cursor]);
    await db.query('COMMIT');return true;
  }catch(error){await db.query('ROLLBACK');if(message)await pool.query("UPDATE cc_email_messages SET delivery_error=$2,next_delivery_sync_at=now()+interval '60 seconds' WHERE message_id=$1",[message.message_id,String(error.message).slice(0,300)]);throw error;}
  finally{db.release();}
}

// One cursor page per lease. Capturing the page and cursor is atomic; restart
// replays the previous page. Full scans repeat to recover missed webhooks.
export async function syncEmailMailbox(pool, { request = emailRequest, content = fetchEmailContent, retain = retainEmailFile } = {}) {
  const db = await pool.connect();
  let mailbox;
  try {
    await db.query('BEGIN');
    // Lease non-key fields without blocking FK checks by the inbox worker.
    mailbox = (await db.query(`SELECT * FROM cc_email_mailboxes WHERE sync_enabled AND next_sync_at<=now()
      ORDER BY next_sync_at FOR NO KEY UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
    if (!mailbox) { await db.query('COMMIT'); return { synced:false }; }
    const params = new URLSearchParams({ 'page[size]':'50', ...(mailbox.sync_cursor ? {'page[after]':mailbox.sync_cursor} : {}) });
    const result = await request(`/email_inboxes/${emailId(mailbox.provider_inbox_id)}/messages?${params}`);
    if (!Array.isArray(result.data)) throw emailError('Invalid inbox response',502);
    for (const message of result.data) {
      if (!message.id || message.direction === 'outbound') continue;
      if (message.labels?.includes('deleted')) {
        // A durable tombstone also fences captured inbox events that have not
        // been applied yet. Their INSERT ON CONFLICT cannot resurrect this row.
        // Keep already admitted messages and their interaction history intact.
        await db.query(`INSERT INTO cc_email_received(mailbox_id,provider_message_id,payload,classification,processed_at)
          VALUES($1,$2,'{}'::jsonb,'deleted',now())
          ON CONFLICT(mailbox_id,provider_message_id) DO UPDATE SET classification='deleted',processed_at=now()
          WHERE cc_email_received.message_id IS NULL`,[mailbox.id,String(message.id)]);
        continue;
      }
      const key = emailEventKey(mailbox.id, String(message.id));
      if ((await db.query('SELECT 1 FROM acd_webhook_events WHERE event_id=$1',[key])).rowCount) continue;
      const payload = {...message};
      const needsText=typeof payload.text_body!=='string'&&!payload.text_body_url;
      const needsHtml=typeof payload.html_body!=='string'&&!payload.html_body_url;
      if(needsText||needsHtml){
        const detail=(await request(`/email_messages/${emailId(message.id)}`)).data;
        if(!detail||detail.id!==message.id||!Object.hasOwn(detail,'text_body')||!Object.hasOwn(detail,'html_body'))throw emailError('Invalid email message detail response',502);
        if(needsText)payload.text_body=detail.text_body;
        if(needsHtml)payload.html_body=detail.html_body;
      }
      if (!payload.text_body && payload.text_body_url) payload.text_body = (await content(payload.text_body_url)).toString('utf8');
      if (!payload.html_body && payload.html_body_url) payload.html_body = (await content(payload.html_body_url)).toString('utf8');
      const files=inboundFiles(payload);
      if(files.length){
        let total=0;const retained=[];
        for(const file of files){
          const bytes=await content(file.url,25_000_000);total+=bytes.length;
          if(total>25_000_000)throw emailError('Email attachments exceed 25 MB',413);
          const {url:_url,...metadata}=file;
          retained.push({...metadata,...await retain(bytes)});
        }
        payload.attachments=retained;
      }
      delete payload.inline_files;
      await persistWebhookEvent(db,{ eventId:key, provider:'telnyx-email', eventType:'email.inbox_message',
        payload:{mailboxId:mailbox.id,message:payload}, sourceRoute:'email:authenticated-sync' });
    }
    const cursor = result.meta?.page_cursor || result.meta?.next_cursor || null;
    if (cursor && cursor === mailbox.sync_cursor) throw emailError('Email provider repeated the pagination cursor',502);
    await db.query(`UPDATE cc_email_mailboxes SET sync_cursor=$2,last_synced_at=now(),last_error=NULL,
      next_sync_at=now()+CASE WHEN $2::text IS NULL THEN interval '60 seconds' ELSE interval '1 second' END WHERE id=$1`,[mailbox.id,cursor]);
    await db.query('COMMIT');
    return {synced:true,count:result.data.length};
  } catch(error) {
    await db.query('ROLLBACK');
    if(mailbox)await pool.query(`UPDATE cc_email_mailboxes SET last_error=$2,next_sync_at=now()+interval '60 seconds' WHERE id=$1`,[mailbox.id,String(error.message).slice(0,300)]);
    throw error;
  } finally { db.release(); }
}

export async function applyEmailInboxEvent(pool, row) {
  if (row.event_type === 'email.inbox_message') {
    const mailbox = (await pool.query('SELECT * FROM cc_email_mailboxes WHERE id=$1',[row.payload.mailboxId])).rows[0];
    if (!mailbox) return 'noop';
    const message = row.payload.message;
    const normalized = normalizeInbound(message);
    const selves = (await pool.query('SELECT address FROM cc_email_mailboxes')).rows.map(r=>r.address);
    let classification = classifyEmail(message,selves);
    // One visible customer email addressed to multiple managed inboxes belongs
    // to the first managed To recipient (then CC). Other copies remain archived.
    const primary=[...normalized.to,...normalized.cc].find(value=>selves.includes(value));
    if(classification==='customer'&&primary&&primary!==mailbox.address)classification='duplicate_mailbox';
    await pool.query(`INSERT INTO cc_email_received(mailbox_id,provider_message_id,payload,classification,processed_at,received_at)
      VALUES($1,$2,$3::jsonb,$4,CASE WHEN $4='customer' THEN NULL ELSE now() END,COALESCE($5::timestamptz,now())) ON CONFLICT DO NOTHING`,
      [mailbox.id,normalized.providerId,JSON.stringify(normalized),classification,normalized.receivedAt]);
    return 'applied';
  }
  if (row.event_type === 'email.received') {
    // Signed hints only wake the authenticated inbox scan, never supply a
    // routing identity or expose provider URLs directly to a browser.
    await pool.query(`UPDATE cc_email_mailboxes SET next_sync_at=LEAST(next_sync_at,now()) WHERE sync_enabled`);
    return 'applied';
  }
  const payload = row.payload || {};
  if (!payload.id) return 'noop';
  // Campaign messages live on the outbound attempt ledger, not in the mailbox
  // thread tables, and carry no recipient identity of their own.
  const campaignStatus = row.event_type.replace(/^email\./,'');
  if (!payload.recipient_id) {
    return applyMessagingDeliveryUpdate(pool, { channel: 'email', providerMessageId: String(payload.id), status: campaignStatus,
      occurredAt: row.occurred_at || payload.occurred_at || null, errorCode: payload.error_evidence?.code ? String(payload.error_evidence.code) : null,
      errorDetail: payload.error_evidence?.message || payload.error_evidence?.source || null, source: row.event_type });
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const message = (await db.query(`SELECT e.message_id,m.work_item_id FROM cc_email_messages e
      JOIN acd_messages m ON m.id=e.message_id WHERE e.provider_message_id=$1 FOR UPDATE OF e`,[payload.id])).rows[0];
    if (!message) {
      await db.query('COMMIT');
      return applyMessagingDeliveryUpdate(pool, { channel: 'email', providerMessageId: String(payload.id), status: campaignStatus,
        occurredAt: row.occurred_at || payload.occurred_at || null, errorCode: payload.error_evidence?.code ? String(payload.error_evidence.code) : null,
        errorDetail: payload.error_evidence?.message || payload.error_evidence?.source || null, source: row.event_type });
    }
    let status = row.event_type.replace(/^email\./,'');
    if (status === 'bounced' && payload.error_evidence?.code === '30005') status='expired';
    if (status === 'bounced' && ['30003','30099'].includes(payload.error_evidence?.code)) status='failed';
    if (!['queued','scheduled','sending','sent','deferred','delivered','bounced','failed','expired','suppressed','sandbox','gw_reject','injection_timeout','cancelled'].includes(status)) {await db.query('COMMIT');return 'noop';}
    const previous=(await db.query('SELECT * FROM cc_email_deliveries WHERE message_id=$1 AND recipient_id=$2',[message.message_id,payload.recipient_id])).rows[0];
    const occurredAt=row.occurred_at || payload.occurred_at || new Date().toISOString();
    if(reduceDelivery(previous,{status,occurredAt})) {
      const kind=payload.bcc?'bcc':payload.cc?'cc':'to';
      await db.query(`INSERT INTO cc_email_deliveries(message_id,recipient_id,kind,address,status,occurred_at,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(message_id,recipient_id) DO UPDATE SET
        status=EXCLUDED.status,occurred_at=EXCLUDED.occurred_at,evidence=EXCLUDED.evidence`,
        [message.message_id,payload.recipient_id,kind,kind==='bcc'?null:payload[kind]?.email || null,status,occurredAt,JSON.stringify(payload.error_evidence || {})]);
      await appendEvent(db,{workItemId:message.work_item_id,type:'email_delivery_updated',actor:'email-provider',payload:{message_id:message.message_id,recipient_id:payload.recipient_id,status}});
    }
    await db.query('COMMIT');return 'applied';
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}

export async function routePendingEmail(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(741901,5)');
    // Share the mailbox lease with sync so an observed deletion commits before
    // admission can inspect its pending row. Skip busy mailboxes without waiting.
    const pending=(await db.query(`SELECT r.*,b.queue_id,b.address FROM cc_email_received r
      JOIN cc_email_mailboxes b ON b.id=r.mailbox_id AND b.routing_enabled AND b.sync_cursor IS NULL
      JOIN cc_queues q ON q.id=b.queue_id AND q.enabled
      JOIN cc_queue_channels qc ON qc.queue_id=q.id AND qc.channel='email' AND qc.enabled
      WHERE r.processed_at IS NULL AND r.classification='customer' AND r.route_after<=now() ORDER BY r.received_at
      FOR UPDATE OF r SKIP LOCKED FOR NO KEY UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if(!pending){await db.query('COMMIT');return false;}
    const mail=pending.payload;
    let thread = mail.threadId ? (await db.query('SELECT * FROM cc_email_threads WHERE mailbox_id=$1 AND provider_thread_id=$2 FOR UPDATE',[pending.mailbox_id,mail.threadId])).rows[0] : null;
    if(!thread && (mail.inReplyTo || mail.references.length)) {
      thread=(await db.query(`SELECT t.* FROM cc_email_threads t JOIN acd_messages m ON m.conversation_id=t.conversation_id
        JOIN cc_email_messages e ON e.message_id=m.id WHERE t.mailbox_id=$1 AND e.rfc_message_id=ANY($2::text[])
        ORDER BY m.seq DESC LIMIT 1 FOR UPDATE OF t`,[pending.mailbox_id,[mail.inReplyTo,...mail.references].filter(Boolean)])).rows[0];
    }
    if(!thread) {
      const conversationId=randomUUID();
      await db.query(`INSERT INTO acd_conversations(id,channel,customer_name,attributes) VALUES($1,'email',$2,$3::jsonb)`,[conversationId,mail.name||mail.from,JSON.stringify({subject:mail.subject,mailbox:pending.address})]);
      thread=(await db.query(`INSERT INTO cc_email_threads(conversation_id,mailbox_id,provider_thread_id,subject)
        VALUES($1,$2,$3,$4) RETURNING *`,[conversationId,pending.mailbox_id,mail.threadId||`message:${mail.providerId}`,mail.subject])).rows[0];
    }
    // Campaign attribution never blocks routing: an error rolls back to the savepoint only.
    await db.query('SAVEPOINT messaging_reply');
    try { await markMessagingReplied(db,{channel:'email',address:mail.from,receivedBy:pending.address}); await db.query('RELEASE SAVEPOINT messaging_reply'); }
    catch { await db.query('ROLLBACK TO SAVEPOINT messaging_reply'); }
    let work=(await db.query('SELECT * FROM acd_work_items WHERE conversation_id=$1 AND terminal_at IS NULL FOR UPDATE',[thread.conversation_id])).rows[0];
    // Only final wrap-up ends the episode. A transferred agent may still be
    // dispositioning while the destination receives new customer messages.
    if(work && (await db.query(`SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
      WHERE a.work_item_id=$1 AND a.state='wrapup' AND s.outcome IS DISTINCT FROM 'transferred'`,[work.id])).rowCount){
      await db.query("UPDATE cc_email_received SET route_after=now()+interval '2 seconds' WHERE mailbox_id=$1 AND provider_message_id=$2",[pending.mailbox_id,pending.provider_message_id]);
      await db.query('COMMIT');return true;
    }
    if(!work) {
      const queue=(await db.query('SELECT * FROM cc_queues WHERE id=$1',[pending.queue_id])).rows[0];
      work=await createWorkItem(db,{channel:'email',direction:'inbound',queueId:pending.queue_id,conversationId:thread.conversation_id,
        customerAddress:mail.from,requiredSkills:queue.skill_requirements||{},attributes:{subject:thread.subject,mailbox:pending.address},actor:'email'});
      await applyTransition(db,{workItemId:work.id,to:'queued',eventType:'work_item_queued',patch:{enqueuedAt:new Date().toISOString()},actor:'email'});
      await openSegment(db,{workItemId:work.id,kind:'queue_wait',queueId:pending.queue_id});
    }
    const messageId=randomUUID();
    await db.query(`INSERT INTO acd_messages(id,conversation_id,work_item_id,sender_role,sender_id,client_id,body,created_at)
      VALUES($1,$2,$3,'customer',$4,$5,$6,COALESCE($7::timestamptz,now()))`,[messageId,thread.conversation_id,work.id,mail.from,mail.providerId,mail.text,mail.receivedAt]);
    await db.query(`INSERT INTO cc_email_messages(message_id,mailbox_id,provider_message_id,envelope,html_body,rfc_message_id,in_reply_to,reference_ids)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb)`,[messageId,pending.mailbox_id,mail.providerId,JSON.stringify({from:mail.from,to:mail.to,cc:mail.cc,replyTo:mail.replyTo,subject:mail.subject,attachments:mail.attachments}),mail.html,mail.messageId,mail.inReplyTo,JSON.stringify(mail.references)]);
    await db.query("UPDATE cc_email_threads SET state='open' WHERE conversation_id=$1",[thread.conversation_id]);
    await db.query('UPDATE cc_email_received SET message_id=$3,processed_at=now() WHERE mailbox_id=$1 AND provider_message_id=$2',[pending.mailbox_id,mail.providerId,messageId]);
    await appendEvent(db,{workItemId:work.id,type:'text_message_created',actor:'email',payload:{message_id:messageId,conversation_id:thread.conversation_id,sender_role:'customer'}});
    await db.query('COMMIT');return true;
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
