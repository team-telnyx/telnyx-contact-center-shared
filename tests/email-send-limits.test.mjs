import test from 'node:test';
import assert from 'node:assert/strict';
import {EMAIL_SEND_REQUEST_BYTES,emailEncodedBytes,emailSendSizeError,draftSendPayload,emailSendFailure} from '../lib/email/send-limits.mjs';
import {buildAgentEmail,parseEmailDraft} from '../lib/email/policy.mjs';
import {emailProvider} from '../lib/email/provider.mjs';
const mailbox={address:'sales@example.com',sending_enabled:true};
const original={provider_message_id:'inbox-id',rfc_message_id:'parent@example.com',envelope:{from:'customer@example.com',to:[mailbox.address],cc:[]}};
const draft={mode:'reply',to:'customer@example.com',subject:'Re: Test',text:'Hi',html:'<p>Hi</p>'};
test('observed 781944-byte attachment fits the documented limits and must not be blocked locally',()=>{
 const value={...draft,attachments:[{filename:'bmw_car.jpg',content_type:'image/jpeg',content:Buffer.alloc(781944).toString('base64')}]};
 assert.equal(parseEmailDraft(value).attachments[0].size_bytes,781944);
 assert.equal(emailSendSizeError(draftSendPayload(value,mailbox.address)),'');
 assert.doesNotThrow(()=>buildAgentEmail({draft:value,mailbox,original}));
});
test('UTF-8 body limit counts text and HTML together but excludes attachments',()=>{
 assert.equal(emailEncodedBytes({text:'Łódź\n"'}),Buffer.byteLength(JSON.stringify({text:'Łódź\n"'})));
 assert.equal(emailSendSizeError({text_body:'x'.repeat(500000),html_body:'x'.repeat(500000)}),'');
 assert.match(emailSendSizeError({text_body:'x'.repeat(500000),html_body:'x'.repeat(500001)}),/body exceeds the 1 MB/);
 assert.match(emailSendSizeError({text_body:'ą'.repeat(500001)}),/body exceeds the 1 MB/);
});
test('decoded attachments use 25 MB message budget; idempotent JSON independently uses 8 MB',()=>{
 assert.match(emailSendSizeError({attachments:[{content:Buffer.alloc(25000001).toString('base64')}]}),/25 MB/);
 assert.match(emailSendSizeError({text_body:'x',attachments:[{content:Buffer.alloc(6000000).toString('base64')}]}),/8 MB encoded/);
 const value={...draft,html:'x'.repeat(300000),attachments:[1,2].map(n=>({filename:n+'.bin',content:Buffer.alloc(300000).toString('base64')}))};
 assert.doesNotThrow(()=>buildAgentEmail({draft:value,mailbox,original}));
 const fixed=emailEncodedBytes({padding:''});
 assert.equal(emailSendSizeError({padding:'x'.repeat(EMAIL_SEND_REQUEST_BYTES-fixed)}),'');
 assert.match(emailSendSizeError({padding:'x'.repeat(EMAIL_SEND_REQUEST_BYTES-fixed+1)}),/8 MB encoded/);
});
test('existing command retries keep the original idempotency key',async()=>{
 const calls=[];const provider=emailProvider(null,async(path,options)=>{calls.push(options);return {data:{id:'accepted'}};});
 const command={operation:'email_send',request:{text_body:'Hi'},commandId:'existing-uncertain-command'};
 await provider.send(command);await provider.send(command);
 assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);
});
test('internal Kafka limit is distinguished from the documented body/message limits',()=>{
 const evidence=emailSendFailure({error:'Kafka payload exceeds size limit (maximum 1048576 bytes)',httpStatus:422,code:'10015'});
 assert.match(evidence.message,/internal size limit/);assert.equal(evidence.code,'10015');assert(!evidence.message.includes('Kafka'));
 assert.match(emailSendFailure({error:'body exceeds size limit (maximum 1 MB)',httpStatus:422}).message,/body exceeds the 1 MB/);
 assert.match(emailSendFailure({error:'message exceeds size limit (maximum 25 MB)',httpStatus:422}).message,/25 MB/);
 assert(!emailSendFailure({error:'Invalid BCC secret@example.com',httpStatus:400}).message.includes('secret@example.com'));
 assert.equal(emailSendFailure(),null);
});
