// Telnyx documented limits: decoded bodies 1 MB, decoded message 25 MB,
// encoded single-send request with Idempotency-Key 8 MB.
// https://developers.telnyx.com/the internal documentation
export const EMAIL_BODY_BYTES = 1_000_000;
export const EMAIL_TOTAL_BYTES = 25_000_000;
export const EMAIL_SEND_REQUEST_BYTES = 8_000_000;
const utf8Bytes=value=>new TextEncoder().encode(String(value||'')).byteLength;
export const emailEncodedBytes = payload => utf8Bytes(JSON.stringify(payload));
export function emailSendSizeError(payload) {
  const bodyBytes=utf8Bytes(payload.text_body)+utf8Bytes(payload.html_body);
  if(bodyBytes>EMAIL_BODY_BYTES)return 'The email body exceeds the 1 MB limit for text and HTML combined. Shorten the message. Your draft is preserved.';
  const attachmentBytes=(payload.attachments||[]).reduce((sum,file)=>{
    const content=String(file.content||'');
    return sum+Math.floor(content.length*3/4)-(content.endsWith('==')?2:content.endsWith('=')?1:0);
  },0);
  if(bodyBytes+attachmentBytes>EMAIL_TOTAL_BYTES)return 'The message exceeds the 25 MB limit for decoded content and attachments. Reduce its size. Your draft is preserved.';
  if(emailEncodedBytes(payload)>EMAIL_SEND_REQUEST_BYTES)return 'This message exceeds the 8 MB encoded request limit for duplicate-safe sending. Reduce its size. Your draft is preserved.';
  return '';
}

// A browser estimate; the server validates the final payload including threading
// headers and normalized recipients before creating an outbound message.
export function draftSendPayload(draft,from) {
  const addresses=value=>String(value||'').split(/[,;\n]/).map(v=>v.trim()).filter(Boolean);
  return {from,to:addresses(draft.to),cc:addresses(draft.cc),bcc:addresses(draft.bcc),subject:String(draft.subject||'').trim(),text_body:draft.text||'',html_body:draft.html||'',
    attachments:(draft.attachments||[]).map(({size_bytes:_size,...file})=>file)};
}

// Return actionable evidence without exposing the provider request, BCC values,
// credentials or arbitrary upstream error text to readers of the conversation.
export function emailSendFailure({error,code,httpStatus}={}) {
  if(!error&&!code&&!httpStatus)return null;
  const detail=String(error||'');
  let message;
  if(/kafka payload exceeds size limit/i.test(detail))message='The email service rejected this message due to an internal size limit that differs from its documented message limits. Your draft is preserved. Contact your administrator with error code 10015.';
  else if(/body exceeds size limit/i.test(detail))message='The email body exceeds the 1 MB limit for text and HTML combined. Shorten the message. Your draft is preserved.';
  else if(/message exceeds size limit/i.test(detail))message='The message exceeds the 25 MB limit for decoded content and attachments. Reduce its size. Your draft is preserved.';
  else message=`The email service rejected this message${httpStatus?` (HTTP ${httpStatus})`:''}. Your draft is preserved. Review it before retrying.`;
  return {code:code?String(code).slice(0,40):null,httpStatus:httpStatus||null,message};
}
