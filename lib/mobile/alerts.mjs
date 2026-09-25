import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import { ensureMobileDeviceSchema } from './devices.mjs';

export async function ensureMobileAlertSchema(db) {
  await ensureMobileDeviceSchema(db);
  await db.query(`CREATE TABLE IF NOT EXISTS cc_mobile_alerts (
    event_id BIGINT NOT NULL, device_id TEXT NOT NULL, user_id TEXT NOT NULL,
    work_item_id UUID NOT NULL, offer_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
    last_error TEXT, PRIMARY KEY(event_id,device_id)
  );
  CREATE INDEX IF NOT EXISTS cc_mobile_alerts_due ON cc_mobile_alerts(next_attempt_at) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS acd_events_mobile_offers ON acd_events(occurred_at) WHERE type='offer_created';`);
}

export function apnsAlertConfiguration(env=process.env) {
  if (!env.APNS_ALERT_KEY_ID || !env.APNS_ALERT_TEAM_ID || !env.APNS_ALERT_PRIVATE_KEY || !env.APNS_ALERT_TOPICS) return null;
  const topics=JSON.parse(env.APNS_ALERT_TOPICS);
  if (!Object.values(topics).every(value=>['sandbox','production'].includes(value))) throw new Error('Invalid APNS_ALERT_TOPICS');
  return { keyId:env.APNS_ALERT_KEY_ID, teamId:env.APNS_ALERT_TEAM_ID, privateKey:env.APNS_ALERT_PRIVATE_KEY.replace(/\\n/g,'\n'), topics };
}
export function mobileAlertPayload(notification) {
  const channel = String(notification.channel || 'interaction').toLowerCase();
  const names = {voice:'☎️ Voice',sms:'💬 SMS',whatsapp:'💬 WhatsApp',email:'✉️ Email',chat:'💬 Chat',video:'🎥 Video'};
  const clean = value => String(value || '').replace(/[\r\n\t]+/g,' ').slice(0,180);
  const name = clean(notification.customer_name);
  const address = clean(notification.customer_address);
  const customer = clean(name && address && name !== address ? `${name} · ${address}` : name || address);
  const queue = clean(notification.queue_name);
  return {aps:{alert:{title:`${names[channel] || 'New interaction'}${queue ? ' · '+queue : ''}`,
    body:customer ? `${customer} — new interaction. Tap to open.` : 'New interaction. Tap to open.'},sound:'default',
    category:'CC_INTERACTION','thread-id':String(notification.work_item_id)},
    interactionId:String(notification.work_item_id),channel,eventId:String(notification.event_id)};
}
let authCache=null;
export async function sendApnsAlert(notification,config=apnsAlertConfiguration()) {
  const environment=config?.topics[notification.bundle_identifier];
  if (!environment) return {status:503,reason:'TopicNotConfigured'};
  if (!authCache || authCache.key!==config.privateKey || Date.now()-authCache.at>40*60000) {
    const key=await importPKCS8(config.privateKey,'ES256');
    authCache={key:config.privateKey,at:Date.now(),token:await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:config.keyId}).setIssuer(config.teamId).setIssuedAt().sign(key)};
  }
  return new Promise((resolve,reject)=>{
    const client=http2.connect(environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');
    let settled=false;
    const finish=(error,result)=>{ if(settled)return;settled=true;client.destroy();error?reject(error):resolve(result); };
    client.setTimeout(5000,()=>finish(new Error('APNs timeout')));
    client.on('error',error=>finish(error));
    const req=client.request({':method':'POST',':path':`/3/device/${notification.alert_token}`,
      authorization:`bearer ${authCache.token}`,'apns-topic':notification.bundle_identifier,'apns-push-type':'alert','apns-priority':'10',
      'apns-expiration':String(Math.floor(new Date(notification.expires_at).getTime()/1000)),
      'apns-collapse-id':String(notification.offer_id)});
    let status=0,body='';
    req.on('response',headers=>{status=Number(headers[':status']);});
    req.on('data',chunk=>{body+=chunk;});req.on('error',error=>finish(error));
    req.on('end',()=>{let reason;try{reason=JSON.parse(body).reason;}catch{}finish(null,{status,reason});});
    req.end(JSON.stringify(mobileAlertPayload(notification)));
  });
}

export async function queueMobileAlerts(db) {
  // Only committed, still-live offers can create alerts. A five-minute replay
  // window is bounded by the offer deadline, with per-device deduplication.
  await db.query(`INSERT INTO cc_mobile_alerts(event_id,device_id,user_id,work_item_id,offer_id,expires_at)
    SELECT e.id,d.device_id,d.user_id,e.work_item_id,o.id,o.deadline_at
      FROM acd_events e JOIN acd_offers o ON o.id::text=e.payload->>'offer_id'
      JOIN cc_mobile_devices d ON d.user_id=e.agent_id AND d.alert_token IS NOT NULL
      JOIN users u ON u.id=d.user_id
      WHERE e.type='offer_created' AND e.occurred_at>now()-interval '5 minutes'
        AND o.state='created' AND o.deadline_at>now()
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(u.refresh_tokens,'[]'::jsonb)) s WHERE s->>'sessionId'=d.auth_session_id)
        AND NOT EXISTS(SELECT 1 FROM cc_agent_voice_preferences p JOIN cc_voice_endpoints v ON v.id=p.endpoint_id
          WHERE p.agent_id=d.user_id AND v.device_id=d.device_id AND e.payload->>'channel'='voice')
      ON CONFLICT DO NOTHING`);
}

export async function drainMobileAlerts(pool,{send=sendApnsAlert,limit=10}={}) {
  await queueMobileAlerts(pool);
  for(let i=0;i<limit;i++) {
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const notification=(await db.query(`SELECT n.*,d.alert_token,d.bundle_identifier,d.auth_session_id,
          w.channel,c.customer_name AS customer_name,w.customer_address,q.name AS queue_name,
          o.state AS offer_state, EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(u.refresh_tokens,'[]'::jsonb)) s WHERE s->>'sessionId'=d.auth_session_id) AS authorized
        FROM cc_mobile_alerts n LEFT JOIN cc_mobile_devices d ON d.device_id=n.device_id AND d.user_id=n.user_id
        LEFT JOIN users u ON u.id=n.user_id LEFT JOIN acd_offers o ON o.id=n.offer_id
        LEFT JOIN acd_work_items w ON w.id=n.work_item_id LEFT JOIN acd_conversations c ON c.id=w.conversation_id
        LEFT JOIN cc_queues q ON q.id=w.queue_id
        WHERE n.status='pending' AND n.next_attempt_at<=now() ORDER BY n.next_attempt_at
        FOR UPDATE OF n SKIP LOCKED LIMIT 1`)).rows[0];
      if(!notification){await db.query('COMMIT');return;}
      let result={status:410,reason:'ExpiredOffer'};
      if(notification.alert_token && notification.authorized && notification.offer_state==='created' && new Date(notification.expires_at)>new Date()) {
        try{result=await send(notification);}catch(error){result={status:503,reason:String(error.message).slice(0,150)};}
      }
      const invalid=result.status===410 || ['BadDeviceToken','Unregistered'].includes(result.reason);
      if(invalid && result.reason!=='ExpiredOffer') await db.query(`UPDATE cc_mobile_devices SET alert_token=NULL WHERE device_id=$1 AND alert_token=$2`,[notification.device_id,notification.alert_token]);
      const status=result.status===200?'sent':invalid || notification.attempts>=5?'discarded':'pending';
      await db.query(`UPDATE cc_mobile_alerts SET status=$3,attempts=attempts+1,last_error=$4,next_attempt_at=now()+make_interval(secs=>$5)
        WHERE event_id=$1 AND device_id=$2`,[notification.event_id,notification.device_id,status,result.reason || null,Math.min(30,2**notification.attempts)]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  }
}
