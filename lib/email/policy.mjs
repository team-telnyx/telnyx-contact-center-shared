import { emailSendSizeError } from './send-limits.mjs';
import { emailError } from './provider.mjs';
import { emailHtmlText } from './content.mjs';

export function address(value) {
  const text = String(typeof value === 'object' && value ? value.email || value.address || '' : value || '').trim().toLowerCase();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(text) || text.length > 254) throw emailError('Enter a valid email address');
  return text;
}
export function addresses(value) {
  const items = Array.isArray(value) ? value : typeof value === 'object' && value ? [value] : String(value || '').split(/[,;\n]/).filter(s => s.trim());
  if (items.length > 100) throw emailError('At most 100 recipients are allowed');
  return [...new Set(items.map(address))];
}
export function messageHeaders(value) {
  const result = {};
  for (const [key, entry] of Array.isArray(value) ? value.map(h => [h.name,h.value]) : Object.entries(value || {})) {
    if (typeof entry === 'string') result[String(key).toLowerCase()] = entry.slice(0,10000);
  }
  return result;
}
// The provider returns RFC IDs separately from headers, sometimes without <>.
// Canonicalize both representations without admitting whitespace/header injection.
export function rfcIds(value) {
  const entries=Array.isArray(value)?value:[value],ids=[];
  for(const entry of entries){
    if(typeof entry!=='string')continue;
    for(const token of entry.slice(0,10000).match(/<[^<>]*>|[^\s,;]+/g)||[]){
      const id=token.startsWith('<')&&token.endsWith('>')?token.slice(1,-1):token;
      if(/^[^<>\s@,;]{1,250}@[^<>\s@,;]{1,250}$/.test(id))ids.push(`<${id}>`);
    }
  }
  return [...new Set(ids)].slice(-100);
}
export function inboundFiles(message) {
  const files=[],seen=new Set();
  for(const [kind,entries] of [['attachment',message.attachments],['inline',message.inline_files]]){
    for(const file of Array.isArray(entries)?entries:[]){
      if(!file||typeof file!=='object')throw emailError('Invalid inbound email attachment',502);
      const contentId=file.content_id?String(file.content_id).replace(/^<|>$/g,''):undefined;
      const key=JSON.stringify([file.storage_key||file.url,contentId,file.filename||file.name]);
      if(seen.has(key))continue;seen.add(key);
      files.push({...file,...(contentId?{content_id:contentId}:{}),disposition:kind==='inline'?'inline':file.disposition||'attachment'});
    }
  }
  return files;
}
export function classifyEmail(message, selfAddresses = []) {
  const headers = messageHeaders(message.headers);
  if(message.labels?.includes('deleted'))return 'deleted';
  if (selfAddresses.includes(address(message.from))) return 'internal';
  if (message.spam === true || ['spam','junk'].some(label => (message.labels || []).includes(label))) return 'spam';
  if ((headers['auto-submitted'] && headers['auto-submitted'].toLowerCase() !== 'no') || headers['x-auto-response-suppress'] || /delivery-status|disposition-notification/i.test(headers['content-type'] || '') || /^(mailer-daemon|postmaster)@/i.test(address(message.from))) return 'automated';
  return 'customer';
}
export function normalizeInbound(message) {
  if (!message?.id) throw emailError('Email message ID is missing',502);
  const headers = messageHeaders(message.headers),references=rfcIds(message.references);
  return {
    providerId: String(message.id), threadId: String(message.thread_id || ''),
    from: address(message.from), name: typeof message.from === 'object' ? String(message.from.name || '') : '',
    to: addresses(message.to), cc: addresses(message.cc),
    replyTo: addresses(message.reply_to).join(', ') || (headers['reply-to'] && !/[<>]/.test(headers['reply-to']) ? addresses(headers['reply-to']).join(', ') : address(message.from)),
    subject: String(message.subject || '(No subject)').slice(0,998),
    text: String(message.text_body || emailHtmlText(message.html_body) || message.reply_text || ''), html: String(message.html_body || ''),
    attachments: inboundFiles(message), headers,
    messageId: rfcIds(message.message_id)[0] || rfcIds(headers['message-id'])[0] || null,
    inReplyTo: rfcIds(message.in_reply_to)[0] || rfcIds(headers['in-reply-to'])[0] || null,
    references: references.length?references:rfcIds(headers.references), receivedAt: Number.isFinite(Date.parse(message.received_at||message.created_at))?new Date(message.received_at||message.created_at).toISOString():null,
  };
}
export function parseEmailDraft(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw emailError('Invalid email draft');
  const draft = {
    mode: input.mode || 'reply', replyMessageId: input.replyMessageId || null,
    to: String(input.to || ''), cc: String(input.cc || ''), bcc: String(input.bcc || ''),
    subject: String(input.subject || ''), text: String(input.text || ''), html: String(input.html || ''),
    scheduledAt: input.scheduledAt || null,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
  };
  if(draft.mode==='new')throw emailError('Agents can only reply to or forward incoming email',403);
  if (!['reply','reply_all','forward'].includes(draft.mode) || draft.subject.length > 998 || /[\r\n]/.test(draft.subject) ||
      [draft.to,draft.cc,draft.bcc].some(v => v.length > 26000) || draft.text.length + draft.html.length > 1_000_000 || draft.attachments.length > 20) throw emailError('Email draft exceeds the supported limits');
  let attachmentBytes = 0;
  draft.attachments = draft.attachments.map(a => {
    if (!a || typeof a.content !== 'string') throw emailError('Invalid attachment content');
    if (a.content.length > 6_666_668) throw emailError('Attachments must total at most 5 MB',413);
    if (a.content.length % 4 || /[^A-Za-z0-9+/=]/.test(a.content) || Buffer.from(a.content,'base64').toString('base64') !== a.content) throw emailError('Invalid attachment content');
    attachmentBytes += Buffer.byteLength(a.content, 'base64');
    const filename = String(a.filename || '').replace(/[\u0000-\u001f\u007f\\/]/g,'_').slice(0,180);
    if (!filename) throw emailError('Attachment filename is required');
    return { ...(a.content_id&&/^[^<>\s\r\n]{1,200}$/.test(a.content_id)?{content_id:a.content_id,disposition:'inline'}:{}), filename, content: a.content, size_bytes: Buffer.byteLength(a.content, 'base64'), content_type: /^[\w.+-]+\/[\w.+-]+$/.test(a.content_type || '') ? a.content_type : 'application/octet-stream' };
  });
  if (attachmentBytes > 5_000_000 || Buffer.byteLength(JSON.stringify(draft)) > 7_800_000) throw emailError('Attachments must total at most 5 MB',413);
  return draft;
}
export function buildAgentEmail({ draft: value, mailbox, original, selfAddresses = [] }) {
  const draft = parseEmailDraft(value);
  if (!mailbox.sending_enabled) throw emailError('Sending is paused for this mailbox',409);
  if (!draft.subject.trim() || !(draft.text.trim() || draft.html.trim())) throw emailError('Subject and message body are required');
  if (!original?.provider_message_id) throw emailError('Select a message from this thread to reply or forward');
  let to = addresses(draft.to), cc = addresses(draft.cc), bcc = addresses(draft.bcc);
  if (['reply','reply_all'].includes(draft.mode)) {
    const allowed = new Set([...addresses(original.envelope.replyTo || original.envelope.from),
      ...(draft.mode === 'reply_all' ? [...original.envelope.to,...original.envelope.cc] : [])].filter(a => !selfAddresses.includes(a)));
    if (!to.length) to = [...allowed].slice(0,1);
    if ([...to,...cc,...bcc].some(a => selfAddresses.includes(a))) throw emailError('Reply recipients cannot include a Contact Center mailbox');
  }
  if (!to.length) throw emailError('At least one To recipient is required');
  if(new Set([...to,...cc,...bcc]).size!==to.length+cc.length+bcc.length)throw emailError('Each recipient must appear in only one of To, CC or BCC');
  const payload = { from: mailbox.address, to, cc: cc.filter(a => !to.includes(a)), bcc: bcc.filter(a => !to.includes(a) && !cc.includes(a)),
    subject: draft.subject.trim(), text_body: draft.text, html_body: draft.html,
    attachments: draft.attachments.map(({size_bytes:_size,...file})=>file) };
  if (['reply','reply_all'].includes(draft.mode)) {
    // Inbox IDs are not outbound email_messages IDs. Preserve the MIME thread
    // directly, without asking the send API to look up an inbound-only UUID.
    const parent = rfcIds(original.rfc_message_id)[0];
    if (parent) payload.headers = { 'In-Reply-To': parent,
      References: [...new Set([...rfcIds(original.reference_ids || []),parent])].slice(-20).join(' ') };
  } else if (draft.mode === 'forward') payload.forward_of_message_id = original.provider_message_id;
  if (draft.scheduledAt) {
    const scheduled = Date.parse(draft.scheduledAt);
    if (!Number.isFinite(scheduled) || scheduled < Date.now() + 60000 || scheduled > Date.now() + 30 * 86400000) throw emailError('Schedule between one minute and 30 days from now');
    // Scheduling is owned by CC; the provider only sees the eventual send.
  }
  const sizeError=emailSendSizeError(payload);
  if(sizeError)throw emailError(sizeError,413);
  return { draft, payload, replyParentId: original.provider_message_id };
}

export function reduceDelivery(previous, incoming) {
  const terminal = new Set(['delivered','bounced','failed','expired','suppressed','cancelled','sandbox','gw_reject','injection_timeout']);
  if (previous && Date.parse(incoming.occurredAt) < Date.parse(previous.occurred_at)) return null;
  if (previous && terminal.has(previous.status) && !terminal.has(incoming.status)) return null;
  return incoming;
}
