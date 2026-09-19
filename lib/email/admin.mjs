import { randomUUID } from 'node:crypto';
import { emailConfig,emailRequest,emailError,emailId } from './provider.mjs';
import { configuredEmailDomains,normalizeEmailDomain,rememberEmailDomain,listEmailDomains,ensureEmailWebhook } from './domains.mjs';
import { address } from './policy.mjs';
import { parseChatCopilotSettings,loadChatCopilotSettings } from '../contact-center/chat-copilot-settings.mjs';
import { loadEmailPreviewSettings,parseEmailPreviewSettings } from './preview-settings.mjs';

export async function emailAdminOverview(db) {
  const config=emailConfig();
  const mailboxes=(await db.query(`SELECT b.*,q.name AS queue_name,
    (SELECT count(*)::int FROM cc_email_received r WHERE r.mailbox_id=b.id AND r.processed_at IS NULL) AS backlog,
    problems.ingest_failed,problems.ingest_retrying,problems.last_ingest_error
    FROM cc_email_mailboxes b JOIN cc_queues q ON q.id=b.queue_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER(WHERE e.status='dead')::int AS ingest_failed,
        count(*) FILTER(WHERE e.status='retryable_failed')::int AS ingest_retrying,
        (array_agg(e.last_error ORDER BY e.received_at DESC))[1] AS last_ingest_error
      FROM acd_webhook_events e WHERE e.provider='telnyx-email' AND e.event_type='email.inbox_message'
        AND e.payload->>'mailboxId'=b.id::text AND e.status IN ('dead','retryable_failed')
    ) problems ON true ORDER BY b.name`)).rows;
  const ingestionFailures=(await db.query(`SELECT e.event_id,e.status,e.attempt_count,e.last_error,e.received_at,e.next_attempt_at,
    e.payload->'message'->>'subject' AS subject,b.address AS mailbox
    FROM acd_webhook_events e JOIN cc_email_mailboxes b ON b.id::text=e.payload->>'mailboxId'
    WHERE e.provider='telnyx-email' AND e.event_type='email.inbox_message' AND e.status IN ('dead','retryable_failed')
    ORDER BY e.received_at DESC LIMIT 100`)).rows;
  const queues=(await db.query(`SELECT q.id,q.name,COALESCE(c.enabled,false) AS email_enabled FROM cc_queues q
    LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='email' WHERE q.enabled ORDER BY q.name`)).rows;
  const audit=(await db.query(`SELECT a.*,
    COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),NULLIF(TRIM(u.username),''),
      'Unknown administrator') AS actor_name
    FROM cc_email_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 30`)).rows;
  const domains=await configuredEmailDomains(db);
  return {domain:domains[0]||null,domains,credentialsConfigured:Boolean(config.apiKey),webhookKeyConfigured:Boolean(process.env.TELNYX_WEBHOOK_PUBLIC_KEY||process.env.TELNYX_WEBHOOK_SECRET),
    webhookPath:'/api/webhooks/telnyx/email',mailboxes,queues,audit,ingestionFailures,copilot:await loadChatCopilotSettings(db,'email'),preview:await loadEmailPreviewSettings(db)};
}

async function ownDomain(db,id,request) {
  const data=(await request(`/email_domains/${emailId(id)}`)).data;
  if(!(await configuredEmailDomains(db)).includes(String(data?.domain||data?.name||'').toLowerCase()))throw emailError('Add this domain to Contact Center first',403);
  return data;
}
async function ownInbox(db,id,request) {
  const inbox=(await request(`/email_inboxes/${emailId(id)}`)).data;
  const email=address(inbox?.email||inbox?.email_address||inbox?.address);
  if(!(await configuredEmailDomains(db)).includes(email.split('@')[1]))throw emailError('Inbox is outside the configured Contact Center mail domains',403);
  return {...inbox,address:email};
}

export async function emailAdminResource(db,params,{request=emailRequest}={}) {
  const resource=params.get('resource'),id=params.get('id'),domainId=params.get('domainId');
  const cursor=params.get('cursor');
  const query=new URLSearchParams({page_size:'50',...(cursor?{page_cursor:cursor}: {})});
  if(resource==='domains') {
    const configured=await configuredEmailDomains(db);
    if(!configured.length)return {data:[]};
    return {data:(await listEmailDomains(request)).filter(d=>configured.includes((d.domain||d.name||'').toLowerCase()))};
  }
  if(resource==='inboxes') {
    const configured=await configuredEmailDomains(db);
    if(!configured.length)return {data:[]};
    const inboxes=[],seen=new Set();
    for(let page=0;page<100;page++){
      const result=await request(`/email_inboxes?${query}`);
      inboxes.push(...(result.data||[]).filter(i=>configured.includes(String(i.email||i.email_address||i.address||'').toLowerCase().split('@')[1])));
      const next=result.meta?.page_cursor||result.meta?.next_cursor;
      if(!next)return {data:inboxes};
      if(seen.has(next))throw emailError('The inbox list could not be loaded completely. Retry the refresh.',502);
      seen.add(next);query.set('page_cursor',next);
    }
    throw emailError('Too many inbox pages to load. Narrow the connected account scope.',502);
  }
  if(['dns','health'].includes(resource)) {
    await ownDomain(db,domainId,request);
    return request(`/email_domains/${emailId(domainId)}/${{dns:'dns_records',health:'health'}[resource]}`);
  }
  if(resource==='filters') {await ownInbox(db,id,request);return request(`/email_inboxes/${emailId(id)}/filters`);}
  if(['templates','suppressions','events'].includes(resource)) {
    const paths={templates:'/email_templates',suppressions:'/email_blocks',events:'/email_events'};
    return request(`${paths[resource]}?${query}`);
  }
  if(resource==='template')return request(`/email_templates/${emailId(id)}`);
  if(resource==='deliveries')return {data:(await db.query(`SELECT e.message_id,e.status,m.created_at,e.envelope->>'subject' AS subject,b.address AS mailbox,
    e.provider_message_id,d.recipient_id,d.kind,CASE WHEN d.kind='bcc' THEN NULL ELSE d.address END AS address,d.status AS delivery_status,d.evidence
    FROM cc_email_messages e JOIN acd_messages m ON m.id=e.message_id JOIN cc_email_mailboxes b ON b.id=e.mailbox_id
    LEFT JOIN cc_email_deliveries d ON d.message_id=e.message_id WHERE m.sender_role='agent' ORDER BY m.created_at DESC LIMIT 100`)).rows};
  throw emailError('Unsupported Email administration resource');
}

export async function emailAdminAction(db,input,actor,{request=emailRequest}={}) {
  const {action}=input;let result,warning,resourceId=input.id||input.domainId||input.inboxId||null;
  if(action==='save_mailbox'){
    const inbox=await ownInbox(db,input.inboxId,request);
    if(!inbox.domain_id)throw emailError('The Email provider did not return the inbox domain ID',502);
    const queue=(await db.query(`SELECT q.id,c.enabled FROM cc_queues q LEFT JOIN cc_queue_channels c ON c.queue_id=q.id AND c.channel='email' WHERE q.id=$1`,[input.queueId])).rows[0];
    if(!queue)throw emailError('Select a queue');
    if(input.routingEnabled&&!queue.enabled)throw emailError('Enable Email in the queue Utilization settings first');
    if(!String(input.name||'').trim())throw emailError('Mailbox name is required');
    if(input.id){
      const saved=await db.query(`UPDATE cc_email_mailboxes SET name=$2,queue_id=$3,routing_enabled=$4,sending_enabled=$5,version=version+1
        WHERE id=$1 AND provider_inbox_id=$6 AND version=$7 RETURNING *`,[input.id,String(input.name).slice(0,120),input.queueId,input.routingEnabled===true,input.sendingEnabled===true,input.inboxId,input.version]);
      if(!saved.rowCount)throw emailError('Mailbox changed. Refresh and retry.',409);result=saved.rows[0];
    }else{
      resourceId=randomUUID();
      result=(await db.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[resourceId,input.inboxId,inbox.domain_id,inbox.address,String(input.name).slice(0,120),input.queueId,input.routingEnabled===true,input.sendingEnabled===true])).rows[0];
    }
  }else if(action==='sync'){
    await db.query('UPDATE cc_email_mailboxes SET next_sync_at=now() WHERE id=$1',[input.id]);result={scheduled:true};
  }else if(action==='retry_ingestion'){
    const owned=await db.query(`SELECT e.event_id FROM acd_webhook_events e
      JOIN cc_email_mailboxes b ON b.id::text=e.payload->>'mailboxId'
      WHERE e.event_id=$1 AND e.provider='telnyx-email' AND e.event_type='email.inbox_message'`,[input.eventId]);
    if(!owned.rowCount)throw emailError('Email processing event not found',404);
    const {executeAcdOperation}=await import('../acd/operations.mjs');
    result=await executeAcdOperation(db,{actorId:actor,requestId:input.requestId,action:'retry_inbox',targetId:input.eventId,
      reason:'Email administrator requested message processing retry'});
    resourceId=input.eventId;
  }else if(action==='save_preview'){
    result=parseEmailPreviewSettings(input.settings);
    await db.query(`INSERT INTO app_settings(id,cc_settings) VALUES('default',jsonb_build_object('email_preview',$1::jsonb))
      ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}'::jsonb)||EXCLUDED.cc_settings`,[JSON.stringify(result)]);
    resourceId='email_preview';
  }else if(action==='save_copilot'){
    const settings=parseChatCopilotSettings(input.settings);
    await db.query(`UPDATE app_settings SET cc_settings=COALESCE(cc_settings,'{}'::jsonb)||jsonb_build_object('email_copilot',$1::jsonb) WHERE id='default'`,[JSON.stringify(settings)]);result=settings;
  }else if(action==='create_domain'){
    const domain=normalizeEmailDomain(input.domain);
    const existing=(await listEmailDomains(request)).find(row=>(row.domain||row.name||'').toLowerCase()===domain);
    result=existing?{data:existing}:await request('/email_domains',{method:'POST',body:{domain,inbound_enabled:true}});
    resourceId=result.data?.id;
    if(!resourceId)throw emailError('Email registration did not return a domain ID',502);
    await rememberEmailDomain(db,domain);
    try{
      if(existing?.inbound?.enabled===false)await request(`/email_domains/${emailId(resourceId)}`,{method:'PATCH',body:{inbound_enabled:true}});
      await ensureEmailWebhook(resourceId,request);
    }catch(error){warning=`Domain added. Integration setup is incomplete: ${error.message}`;}
  }else if(['verify_domain','create_inbox'].includes(action)){
    const domain=await ownDomain(db,input.domainId,request);
    const root=`/email_domains/${emailId(input.domainId)}`;
    if(action==='verify_domain'){
      result=await request(`${root}/verify`,{method:'POST'});
      try{
        if(domain.inbound?.enabled===false)await request(root,{method:'PATCH',body:{inbound_enabled:true}});
        await ensureEmailWebhook(input.domainId,request);
      }
      catch(error){warning=`DNS verification completed. Integration setup is incomplete: ${error.message}`;}
    }
    if(action==='create_inbox'){
      if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.username||''))throw emailError('Enter a valid mailbox local part');
      result=await request('/email_inboxes',{method:'POST',body:{username:input.username,domain_id:input.domainId}});
    }
  }else if(['save_template','delete_template'].includes(action)){
    const payload=input.payload||{};
    if(action==='save_template'&&(!payload.name||!payload.subject||!payload.html_body&&!payload.text_body))throw emailError('Template name, subject and content are required');
    result=await request(`/email_templates${input.id?`/${emailId(input.id)}`:''}`,{method:action==='delete_template'?'DELETE':input.id?'PATCH':'POST',
      ...(action==='save_template'?{body:{name:String(payload.name).slice(0,120),subject:String(payload.subject).slice(0,998),html_body:String(payload.html_body||''),text_body:String(payload.text_body||'')}}:{})});
  }else if(action==='save_filters'){
    await ownInbox(db,input.inboxId,request);
    const {type,entries}=input.payload||{};
    if(!['allowlist','blocklist'].includes(type)||!Array.isArray(entries)||entries.length>500||entries.some(entry=>typeof entry!=='string'))throw emailError('Select a filter list with at most 500 sender entries');
    const desired=[...new Set(entries.map(entry=>{const value=entry.trim().toLowerCase();return value.startsWith('@')?`@${normalizeEmailDomain(value.slice(1))}`:address(value);}))];
    const root=`/email_inboxes/${emailId(input.inboxId)}/filters`,current=(await request(root)).data;
    if(!Array.isArray(current?.allowlist)||!Array.isArray(current?.blocklist))throw emailError('Invalid inbox filter response',502);
    // Mutate only the selected list. Replacing both lists with PUT can erase
    // independent changes to the other list between the read and write.
    const removed=current[type].filter(entry=>!desired.includes(entry)),added=desired.filter(entry=>!current[type].includes(entry));
    result={data:current};
    if(removed.length)result=await request(root,{method:'DELETE',body:{type,entries:removed}});
    if(added.length)result=await request(root,{method:'POST',body:{type,entries:added}});
  }else if(action==='create_suppression'){
    result=await request('/email_blocks',{method:'POST',body:{to:address(input.address),reason:'manual_block'}});
  }else if(action==='delete_suppression'){
    result=await request(`/email_blocks/${emailId(input.id)}`,{method:'DELETE'});
  }else throw emailError('Unsupported Email administration action');
  await db.query('INSERT INTO cc_email_audit(actor_id,action,resource_id) VALUES($1,$2,$3)',[actor,action,resourceId]);
  return {ok:true,result,...(warning?{warning}:{})};
}
