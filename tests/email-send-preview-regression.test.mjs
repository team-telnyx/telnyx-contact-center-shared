import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentEmail } from '../lib/email/policy.mjs';
import { emailProvider } from '../lib/email/provider.mjs';
import { emailMessageStatus } from '../lib/email/message-status.mjs';

test('inbound replies use RFC headers without looking up inbox IDs as outbound messages',async()=>{
  const original={provider_message_id:'inbound-only-id',rfc_message_id:'root@example.com',reference_ids:['older@example.com'],
    envelope:{from:'customer@example.com',to:['support@example.com'],cc:[]}};
  const {payload,replyParentId,draft}=buildAgentEmail({original,mailbox:{address:'support@example.com',sending_enabled:true},
    draft:{mode:'reply',to:'customer@example.com',subject:'Re: Support',text:'Reply',attachments:[{filename:'note.txt',content:'SGk=',content_type:'text/plain'}]}});
  assert.equal(replyParentId,original.provider_message_id);
  assert.equal(payload.in_reply_to_message_id,undefined);
  assert.equal(payload.forward_of_message_id,undefined);
  assert.deepEqual(payload.headers,{'In-Reply-To':'<root@example.com>',References:'<older@example.com> <root@example.com>'});
  assert.equal(draft.attachments[0].size_bytes,2);
  assert.equal(payload.attachments[0].size_bytes,undefined);
  const requests=[];
  const provider=emailProvider(null,async(path,options)=>{
    assert.equal(path,'/email_messages');
    // Reproduce the production provider distinction between inbox and sent IDs.
    if(options.body.in_reply_to_message_id)throw Object.assign(Error('The requested in_reply_to_message_id was not found'),{status:404});
    requests.push(options);return {data:{id:'outbound-id'}};
  });
  assert.equal((await provider.send({operation:'email_send',commandId:'same-reply',request:payload})).outcome,'accepted');
  await provider.send({operation:'email_send',commandId:'same-reply',request:payload});
  assert.equal(requests[0].idempotencyKey,requests[1].idempotencyKey);
});

test('email status distinguishes send acceptance, partial evidence, delivery and failure',()=>{
  assert.deepEqual(emailMessageStatus({status:'failed'}),{status:'failed',label:'Failed',tone:'danger',title:'Failed'});
  assert.equal(emailMessageStatus({status:'accepted'}).label,'Sent');
  assert.equal(emailMessageStatus({status:'draft'}).tone,'warning');
  assert.equal(emailMessageStatus({status:'scheduled'}).tone,'info');
  const message={status:'accepted',recipient_count:2,deliveries:[{status:'delivered'}]};
  assert.equal(emailMessageStatus(message).label,'Sent');
  assert.equal(emailMessageStatus({...message,deliveries:[{status:'failed'}]}).status,'partial_failure');
  assert.equal(emailMessageStatus({...message,deliveries:[{status:'delivered'},{status:'delivered'}]}).status,'delivered');
  assert.equal(emailMessageStatus({...message,deliveries:[{status:'failed'},{status:'failed'}]}).status,'failed');
});

test('complete sandbox evidence is not presented as a sent email', () => {
  const message = { status: 'accepted', recipient_count: 2, deliveries: [{status: 'sandbox'}, {status: 'sandbox'}] };
  assert.deepEqual(emailMessageStatus(message), {status: 'sandbox', label: 'Sandbox', tone: 'neutral', title: 'Sandbox'});
  assert.equal(emailMessageStatus({...message, deliveries: [{status: 'sandbox'}]}).status, 'accepted');
  assert.equal(emailMessageStatus({...message, recipient_count: 0}).status, 'accepted');
  assert.equal(emailMessageStatus({...message, deliveries: [{status: 'sandbox'}, {status: 'delivered'}]}).status, 'accepted');
  assert.equal(emailMessageStatus({...message, deliveries: [{status: 'sandbox'}, {status: 'failed'}]}).status, 'partial_failure');
  assert.equal(emailMessageStatus({...message, status: 'scheduled'}).status, 'scheduled');
});
