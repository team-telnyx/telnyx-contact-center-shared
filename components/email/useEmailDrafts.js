"use client";
import { useCallback,useEffect,useRef,useState } from 'react';

const accepted=new Set(['accepted','sent','delivered','scheduled','deferred','bounced']);
export default function useEmailDrafts(endpoint,{canEdit,onChanged}) {
  const requests=useRef(0),appliedRequest=useRef(0),epoch=useRef(0),closed=useRef(new Set()),records=useRef(new Map()),mounted=useRef(true),initialized=useRef(false),detailRef=useRef(null),editableRef=useRef(canEdit);
  editableRef.current=canEdit;
  const [drafts,setDrafts]=useState([]),[detail,setDetail]=useState(null),[error,setError]=useState('');
  const publish=useCallback(()=>{if(mounted.current)setDrafts([...records.current.values()].map(row=>({...row})));},[]);
  const refresh=useCallback(async()=>{
    const started=epoch.current,requestId=++requests.current;
    try{
      const versions=Object.fromEntries([...records.current.values()].filter(row=>!row.conflict).map(row=>[row.id,row.version]));
      const response=await fetch(`${endpoint}?draftVersions=${encodeURIComponent(JSON.stringify(versions))}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error||'Unable to load email');
      if(!mounted.current||requestId<appliedRequest.current)return;
      appliedRequest.current=requestId;
      detailRef.current=data;setDetail(data);setError('');
      if(started!==epoch.current)return data;
      for(const server of data.drafts||[]){
        if(closed.current.has(server.id))continue;
        const row=records.current.get(server.id);
        if(!row){records.current.set(server.id,{id:server.id,content:server.content,version:String(server.version),saved:JSON.stringify(server.content),chain:Promise.resolve(),submittedMessageId:server.submittedMessageId});}
        else if(!row.saving&&!row.dirty&&!row.pending){if(server.content!==undefined){row.content=server.content;row.saved=JSON.stringify(server.content);}row.version=String(server.version);row.submittedMessageId=server.submittedMessageId;}
        if(row?.submittedMessageId||server.submittedMessageId){const current=records.current.get(server.id);current.version=String(server.version);current.submittedMessageId=server.submittedMessageId;}
      }
      for(const row of records.current.values()){
        if(!row.dirty&&!row.saving&&!row.pending&&!row.submittedMessageId&&row.version!=='0'&&!data.drafts.some(d=>d.id===row.id)){records.current.delete(row.id);continue;}
        const message=data.messages.find(m=>m.id===row.submittedMessageId);
        if(message&&accepted.has(message.status)){clearTimeout(row.timer);closed.current.add(row.id);records.current.delete(row.id);continue;}
        if(message&&['failed','cancelled'].includes(message.status)){
          row.pending=null;row.submittedMessageId=null;row.dirty=true;row.error=message.sendError?.message||'Sending failed. Your draft is preserved. Review it and retry.';
          const server=data.drafts?.find(d=>d.id===row.id);if(server)row.version=String(server.version);else if(row.id==='legacy')row.version=String(data.draft.version);
        }
        if(message&&message.status==='ambiguous')row.error='The send outcome is uncertain. Waiting for delivery evidence; do not send another copy.';
      }
      initialized.current=true;publish();return data;
    }catch(e){if(mounted.current)setError(e.message);}
  },[endpoint,publish]);
  const persist=useCallback((row,discard=false)=>{
    const content=row.content;
    const task=row.chain.catch(()=>{}).then(async()=>{
      if(row.conflict)throw Error('This draft changed in another session. Reload its saved version.');
      if(!discard&&JSON.stringify(content)===row.saved&&!row.dirty)return;
      epoch.current++;row.saving=true;publish();
      try{
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:discard?'discard_draft':'draft',draftId:row.id,content,expectedDraftVersion:row.version})});
        const data=await response.json();if(!response.ok){if(response.status===409)row.conflict=true;throw Error(data.error||'Unable to save draft');}
        epoch.current++;row.version=String(data.version);row.saved=JSON.stringify(content);row.dirty=JSON.stringify(row.content)!==row.saved;row.error='';
      }catch(e){row.error=e.message;throw e;}finally{row.saving=false;publish();}
    });row.chain=task;return task;
  },[endpoint,publish]);
  const change=useCallback((id,patch)=>{
    const row=records.current.get(id);if(!row||row.sending||row.discarding||row.pending||row.submittedMessageId||!editableRef.current)return;
    epoch.current++;
    row.content={...row.content,...patch};row.dirty=true;clearTimeout(row.timer);publish();
    row.timer=setTimeout(()=>void persist(row).catch(()=>{}),500);
  },[persist,publish]);
  function create(content){
    if(records.current.size>=20)throw Error('At most 20 draft tabs are allowed.');
    const id=crypto.randomUUID(),row={id,content,version:'0',saved:'',dirty:true,chain:Promise.resolve()};
    epoch.current++;records.current.set(id,row);publish();void persist(row).catch(()=>{});return id;
  }
  async function discard(id){
    const row=records.current.get(id);if(!row||row.discarding||row.pending||row.submittedMessageId)return;
    row.discarding=true;epoch.current++;clearTimeout(row.timer);publish();
    try{await persist(row,true);closed.current.add(id);records.current.delete(id);}finally{row.discarding=false;publish();}
  }
  async function reload(id){
    const row=records.current.get(id);if(!row)return;
    clearTimeout(row.timer);row.conflict=true;await row.chain.catch(()=>{});
    const data=await refresh(),server=data?.drafts.find(d=>d.id===id);
    if(!data)return;
    if(!server){records.current.delete(id);}else{Object.assign(row,{content:server.content,version:String(server.version),saved:JSON.stringify(server.content),dirty:false,conflict:false,error:'',submittedMessageId:server.submittedMessageId});}
    publish();
  }
  async function send(id){
    const row=records.current.get(id);if(!row||row.sending||row.submittedMessageId||!editableRef.current)return;
    epoch.current++;row.sending=true;clearTimeout(row.timer);publish();
    try{
      if(!row.pending){await persist(row);row.pending={action:'send',retainDraft:true,draftId:row.id,commandId:crypto.randomUUID(),expectedVersion:detailRef.current.work.version,content:row.content,draftVersion:row.version};}
      publish();
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(row.pending)});
      const data=await response.json();
      if(!response.ok){if(response.status<500)row.pending=null;throw Error(data.error||'Unable to confirm send. Retry with the same command.');}
      row.submittedMessageId=data.messageId;row.dirty=false;
      await refresh();onChanged?.();
    }catch(e){row.error=e.message;}finally{row.sending=false;publish();}
  }
  useEffect(()=>{
    const currentRecords=records.current;mounted.current=true;void refresh();const interval=setInterval(()=>void refresh(),2500);
    const beforeUnload=event=>{if([...records.current.values()].some(row=>row.dirty||row.saving||row.sending)){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',beforeUnload);
    window.addEventListener('contact-center:chat-changed',refresh);
    return()=>{mounted.current=false;clearInterval(interval);window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('contact-center:chat-changed',refresh);
      for(const row of currentRecords.values()){clearTimeout(row.timer);if(editableRef.current&&row.dirty&&!row.pending&&!row.submittedMessageId)void persist(row).catch(()=>{});}
    };
  },[refresh,persist]);
  return {detail,drafts,error,change,create,discard,reload,send,refresh,loading:!initialized.current};
}
