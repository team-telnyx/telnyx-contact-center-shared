import { voiceReachableSql } from "../acd/push-readiness.mjs";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function normalizeWatchDestination(value) {
  const text = String(value || '').trim();
  if (/^sips?:/i.test(text)) {
    // Directory addresses only. Reject headers, URI credentials and control characters.
    if (!/^sip:[a-z0-9_.+%-]+@[a-z0-9.-]+(?::\d{1,5})?(?:;transport=(?:tcp|udp|tls)|;secure=srtp)?$/i.test(text) || text.length>300)
      throw fail(400,'This SIP address is not supported.');
    return text;
  }
  const number = text.replace(/[ ()-]/g,'');
  if (!/^\+[1-9]\d{6,14}$/.test(number)) throw fail(400,'Use an international number, for example +48221234567, or a SIP URI.');
  return number;
}
export const contactFields = ['mobile','phone','business_phone_1','business_phone_2','home_phone_1','home_phone_2'];
export async function resolveWatchTarget(pool, user, body, env=process.env) {
  if (!['contact','colleague','device_contact'].includes(body?.kind) ||
      (body.kind !== 'device_contact' && (typeof body.id!=='string' || body.id.length>100)))
    throw fail(400,'Choose a contact or colleague.');
  let to, name;
  if(body.kind==='device_contact') {
    // The signed-in agent selected a local address-book number. Never accept a
    // device contact identifier, display name, SIP URI, or caller ID as authority.
    if(typeof body.destination !== 'string' || body.destination.length > 80 || /^sips?:/i.test(body.destination.trim()))
      throw fail(400,'Choose an international phone number from this contact.');
    to=normalizeWatchDestination(body.destination);
    name=to;
  } else if(body.kind==='contact') {
    const contact=(await pool.query('SELECT * FROM contacts WHERE id::text=$1 AND deleted_at IS NULL',[body.id])).rows[0];
    if(!contact) throw fail(404,'Contact unavailable.');
    const choices=contactFields.map(k=>contact[k]).filter(Boolean);
    const selected=choices.find(v=>String(v).trim()===String(body.destination||'').trim());
    if(!selected) throw fail(400,'Choose an address saved on this contact.');
    to=normalizeWatchDestination(selected);
    name=contact.display_name || [contact.first_name,contact.last_name].filter(Boolean).join(' ') || to;
  } else {
    if(body.id===String(user.id)) throw fail(400,'Choose another colleague.');
    const colleague=(await pool.query(`SELECT u.*, p.endpoint_id, e.sip_username AS selected_sip, e.revoked_at,
      ${voiceReachableSql("e")} AS reachable
      FROM users u LEFT JOIN cc_agent_voice_preferences p ON p.agent_id=u.id
      LEFT JOIN cc_voice_endpoints e ON e.id=p.endpoint_id WHERE u.id::text=$1 AND u.active IS DISTINCT FROM false`,[body.id])).rows[0];
    if(!colleague) throw fail(404,'Colleague unavailable.');
    if(colleague.endpoint_id && !colleague.reachable)
      throw fail(409, 'This colleague’s selected phone is offline. Ask them to sign in or select an available Calls On device.');
    const sip=colleague.endpoint_id ? (colleague.revoked_at ? null : colleague.selected_sip) : colleague.telephony_user_name;
    if(!sip || !/^[a-z0-9_.+-]+$/i.test(sip)) throw fail(409,'This colleague has no active SIP identity.');
    to=`sip:${sip}@sip.telnyx.com`;
    name=[colleague.first_name,colleague.last_name].filter(Boolean).join(' ') || colleague.username;
  }
  const connectionId=env.TELNYX_WATCH_VOICE_APP_ID || env.TELNYX_DEFAULT_FLOW_VOICE_APP_ID;
  const from=env.TELNYX_WATCH_FROM_NUMBER || user.voice_number || env.TELNYX_MAIN_FROM_NUMBER;
  if(!connectionId || !/^\+[1-9]\d{6,14}$/.test(from||'')) throw fail(503,'Watch calling needs a Voice API application and an outbound caller ID.');
  const webhook=new URL('/api/mobile/v1/watch/voice-webhook',env.APP_BASE_URL);
  if(webhook.protocol!=='https:') throw fail(503,'A public HTTPS application URL is required.');
  return {callerName:[user.first_name,user.last_name].filter(Boolean).join(" "),kind:body.kind,id:body.kind==='device_contact' ? null : body.id,to,name,from,connectionId,webhookURL:webhook.href};
}
