import test from 'node:test';
import assert from 'node:assert/strict';
import {withStreamedAttachment} from '../lib/widgets/multipart-upload.js';
const policy={maximumBytes:32,mimeTypes:['text/plain']};
function upload(size=32,type='text/plain',extra=false){
  const form=new FormData();form.set('file',new File(['x'.repeat(size)],'file.txt',{type}));form.set('messageId','message');
  if(extra)form.set('extra','no');
  return new Request('https://upload.example',{method:'POST',body:form});
}
test('streamed multipart permits the exact limit and cleans its temporary file',async()=>{
  let file;
  const size=await withStreamedAttachment(upload(),policy,async value=>{file=value.file;assert.equal(value.clientId,'message');return (await file.arrayBuffer()).length;});
  assert.equal(size,32);await assert.rejects(file.arrayBuffer(),{code:'ENOENT'});
});
test('streamed multipart rejects over-limit files, disabled MIME and extra fields before storage',async()=>{
  let stored=0;const save=()=>{stored++;};
  await assert.rejects(withStreamedAttachment(upload(33),policy,save),{status:413});
  await assert.rejects(withStreamedAttachment(upload(4,'image/png'),policy,save),{status:403});
  await assert.rejects(withStreamedAttachment(upload(4,'text/plain',true),policy,save),{status:400});
  assert.equal(stored,0);
});
test('storage failure preserves the error and still deletes the streamed file',async()=>{
  let file;const failure=Object.assign(Error('Database unavailable'),{status:503});
  await assert.rejects(withStreamedAttachment(upload(),policy,async value=>{file=value.file;throw failure;}),error=>error===failure);
  await assert.rejects(file.arrayBuffer(),{code:'ENOENT'});
});
test('declared oversized multipart is rejected without touching the body stream',async()=>{
  const request={headers:new Headers({'content-length':String(policy.maximumBytes+65537)}),get body(){throw Error('Must not read body');}};
  await assert.rejects(withStreamedAttachment(request,policy,()=>{}),{status:413});
});
