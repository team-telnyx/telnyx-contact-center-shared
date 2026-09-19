import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecipients,splitRecipients,validRecipient } from '../lib/email/recipients.mjs';
import { buildAgentEmail,parseEmailDraft } from '../lib/email/policy.mjs';

test('recipient paste normalizes separators and preserves distinct plus and dotted addresses',()=>{
  const values=splitRecipients(' A@example.com; b+tag@example.com,\nb.name@example.com ');
  assert.deepEqual(values,['A@example.com','b+tag@example.com','b.name@example.com']);assert(values.every(validRecipient));
  assert.equal(validRecipient('name <a@example.com>'),false);assert.equal(validRecipient('wrong'),false);
});
test('adding recipients never silently exposes BCC and deduplicates case-insensitively',()=>{
  const result=addRecipients({to:'a@example.com',cc:'cc@example.com',bcc:'secret@example.com'},'to',['A@example.com','SECRET@example.com','new@example.com']);
  assert.equal(result.value,'a@example.com, new@example.com');assert.deepEqual(result.duplicates,[{address:'SECRET@example.com',field:'bcc'}]);
});
test('reply may add chosen contacts while retaining its customer parent and hiding BCC from other recipient lists',()=>{
  const original={provider_message_id:'inbound',rfc_message_id:'root@example.com',envelope:{from:'customer@example.com',to:['support@example.com'],cc:[]}};
  const content={mode:'reply',to:'customer@example.com',cc:'contact@example.com',bcc:'private@example.com',subject:'Re: Help',text:'Reply'};
  const result=buildAgentEmail({draft:content,original,mailbox:{address:'support@example.com',sending_enabled:true},selfAddresses:['support@example.com']});
  assert.deepEqual(result.payload.cc,['contact@example.com']);assert.deepEqual(result.payload.bcc,['private@example.com']);assert.equal(result.payload.headers['In-Reply-To'],'<root@example.com>');
  assert.throws(()=>buildAgentEmail({draft:content,original:null,mailbox:{sending_enabled:true}}),/Select a message/);
  assert.throws(()=>parseEmailDraft({...content,mode:'new'}),/only reply/);
});

test('send validation rejects cross-field duplicates and preserves inline attachment MIME metadata',()=>{
  const original={provider_message_id:'inbound',envelope:{from:'customer@example.com',to:[],cc:[]}},mailbox={address:'support@example.com',sending_enabled:true};
  const draft={mode:'forward',to:'contact@example.com',bcc:'CONTACT@example.com',subject:'Fwd: Help',text:'Forward'};
  assert.throws(()=>buildAgentEmail({draft,original,mailbox}),/only one of To, CC or BCC/);
  const {payload}=buildAgentEmail({draft:{...draft,bcc:'',attachments:[{filename:'logo.png',content:'SGk=',content_type:'image/png',content_id:'logo'}]},original,mailbox});
  assert.equal(payload.attachments[0].content_id,'logo');assert.equal(payload.attachments[0].disposition,'inline');
});
