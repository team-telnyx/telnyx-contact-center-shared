import { NOTIFICATION_CHANNELS } from './notification-sounds.mjs';

export function pendingInteractionOffers(interactions,now=Date.now()) {
  const ids=new Set();
  return (interactions||[]).filter(item=>{
    if(!item.id||!item.offer_id||ids.has(item.offer_id)||!NOTIFICATION_CHANNELS.includes(item.channel)||!['ringing','offered'].includes(item.state)||item.terminal_at)return false;
    if(item.offer_deadline&&!(Date.parse(item.offer_deadline)>now))return false;
    ids.add(item.offer_id);return true;
  });
}
export const interactionChannelName=channel=>({chat:'chat',email:'email',whatsapp:'WhatsApp',sms:'SMS',video:'video call'}[channel]||'interaction');
