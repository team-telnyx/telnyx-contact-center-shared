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
