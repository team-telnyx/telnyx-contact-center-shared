import React from 'react';
import {createRoot} from 'react-dom/client';
import EmailInteractionDetail from '../../components/contact-center/EmailInteractionDetail.jsx';
const original={id:'11111111-1111-1111-1111-111111111111',sender_role:'customer',body:'I need more information about SMS with SMPP.\nThank you, Alex',html_body:'<h2>SMS with SMPP</h2><p>I need more information about SMS with SMPP.</p>'+Array.from({length:16},(_,i)=>`<p>Technical question ${i+1}: Please explain the integration options.</p>`).join(''),envelope:{from:'alex@example.com',replyTo:'alex@example.com',to:['support@example.com'],cc:['colleague@example.com'],subject:'SMS with SMPP'},created_at:new Date().toISOString(),attachments:[],deliveries:[],status:'received'};
const initial={work:{id:'work',version:'1'},mailbox:{id:'mailbox',address:'support@example.com',subject:'SMS with SMPP',sending_enabled:true},messages:[original],drafts:[],draft:{content:null,version:'0'},selfAddresses:['support@example.com'],preview:{format:'html',loadRemoteImages:false,showInlineImages:true}};
let db=JSON.parse(localStorage.getItem('email-tabs-fixture')||'null')||initial;
const save=()=>localStorage.setItem('email-tabs-fixture',JSON.stringify(db));
window.fixture={db,requests:[],failNext:false,delayNext:false};
window.fetch=async(url,options={})=>{
  url=String(url);window.fixture.requests.push({url,body:options.body});await new Promise(r=>setTimeout(r,80));
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  if(url.endsWith('/copilot'))return json({settings:{model:'test/model',bucketIds:[]},latest:{requestId:'ai',question:'Help me answer',generatedAt:new Date().toISOString(),suggestions:[{text:'Here is the AI answer about SMPP.',confidence:0.9}]}});
  if(url.includes('/recipients?')){const p=new URL(url,location.origin).searchParams,q=p.get('q').toLowerCase();const data=[{contact_id:'one',name:'Alex Taylor',email:'alex@example.com',company:'Example Ltd',position:1},{contact_id:'one',name:'Alex Taylor',email:'alex.work@example.com',company:'Example Ltd',position:2},{contact_id:'two',name:'Pat Smith',email:'pat@example.com',company:'Partner',position:1}].filter(c=>JSON.stringify(c).toLowerCase().includes(q));return json({data,total:data.length});}
  if(url.endsWith('/templates'))return json({data:[]});
  if(!options.method){const versions=JSON.parse(new URL(url,location.origin).searchParams.get('draftVersions')||'{}');return json({...db,drafts:db.drafts.map(row=>versions[row.id]===row.version?{...row,content:undefined}:row)});}
  const input=JSON.parse(options.body);
  if(input.action==='prepare_forward')return json({content:{mode:'forward',replyMessageId:original.id,to:'',cc:'',bcc:'',subject:'Fwd: SMS with SMPP',html:'<p><br></p><blockquote data-email-forward="true">'+original.html_body+'</blockquote>',text:original.body,attachments:[{filename:'spec.txt',content:'SGk=',content_type:'text/plain',size_bytes:2}],scheduledAt:null}});
  const row=db.drafts.find(d=>d.id===input.draftId);
  if(input.action==='draft'||input.action==='discard_draft'){
    if(String(row?.version||0)!==input.expectedDraftVersion)return json({error:'Draft changed in another session'},409);
    const next={id:input.draftId,content:input.action==='discard_draft'?null:input.content,version:String(Number(row?.version||0)+1),submittedMessageId:null};
    db.drafts=db.drafts.filter(d=>d.id!==next.id);if(next.content)db.drafts.push(next);save();return json(next);
  }
  if(input.action==='send'){
    if(window.fixture.failProviderNext){
      window.fixture.failProviderNext=false;
      const id=crypto.randomUUID();db.messages.push({...original,id,sender_role:'agent',status:'failed',sendError:{code:'10015',httpStatus:422,message:'The email service rejected this message due to an internal size limit that differs from its documented message limits. Your draft is preserved. Contact your administrator with error code 10015.'}});
      row.submittedMessageId=id;row.version=String(Number(row.version)+1);save();return json({ok:true,messageId:id});
    }
    if(window.fixture.failNext){window.fixture.failNext=false;return json({error:'Simulated rejection'},422);}
    const message={...original,id:crypto.randomUUID(),sender_role:'agent',body:input.content.text,html_body:input.content.html,envelope:{from:'support@example.com',to:input.content.to.split(','),cc:[],subject:input.content.subject},status:input.content.scheduledAt?'scheduled':'accepted'};db.messages.push(message);db.drafts=db.drafts.filter(d=>d.id!==input.draftId);save();return json({ok:true,messageId:message.id});
  }
  return json({ok:true});
};
createRoot(document.getElementById('root')).render(<div className="flex h-screen flex-col bg-background text-foreground"><header className="shrink-0 border-b p-4 text-lg font-semibold">Agent Desktop · Email workspace</header><main className="flex min-h-0 flex-1 gap-3 p-3"><aside className="w-56 shrink-0 rounded-xl border p-4"><h2 className="mb-4 font-semibold">Interactions</h2><div className="rounded-xl border-2 border-amber-500 bg-amber-500/5 p-3 text-amber-500"><p className="text-xs">SUPPORT · Active</p><p className="font-semibold">Alex Taylor</p><p className="text-xs">SMS with SMPP</p></div></aside><div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"><EmailInteractionDetail interaction={{id:'work',state:'active',queue_name:'Support'}}/></div></main></div>);
