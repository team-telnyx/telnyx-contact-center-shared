import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {providerResponseStatus} from '../lib/provider-http-status.mjs';

// Execute the real route handler with a failed provider response. Auth has
// already succeeded at the guard; upstream auth must not look like app auth.
for (const [path,query] of [
 ['app/api/admin/connections/route.js','?pageSize=25&kind=sip'],
 ['app/api/admin/messaging-profiles/route.js','?pageSize=25'],
 ['app/api/admin/numbers/[id]/route.js',''],
]) {
 test(`${path}: provider 401/403 cannot become a mobile authentication failure`,async()=>{
  const source=(await readFile(new URL('../'+path,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/export const /g,'const ');
  for(const status of [401,403,404,429,503]) {
   const handler=new Function('NextResponse','fetch','providerResponseStatus','withPermission','adminRuntimeLogger','runtimePayload',
     source+'\nreturn GET;')({json:(body,options={})=>({body,status:options.status||200})},
     async()=>({ok:false,status,text:async()=>''}),providerResponseStatus,(_p,fn)=>fn,{error(){}},()=>({}));
   const response=await handler(new Request('https://example.test'+query),{params:Promise.resolve({id:'number'})});
   assert.equal(response.status,status===401||status===403?502:status);
  }
 });
}
