"use client";
import { useEffect,useRef,useState } from 'react';
import { Brain,ChevronDown,Forward,Mail,Reply,ReplyAll,X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import EmailBody,{textToEmailHtml} from '@/components/email/EmailBody';
import EmailAttachments from '@/components/email/EmailAttachments';
import EmailMessageStatus from '@/components/email/EmailMessageStatus';
import EmailDraftComposer,{serializeComposerHtml} from '@/components/email/EmailDraftComposer';
import { sanitizeEmailTemplateHtml } from '@/components/email/template-html';
import useEmailDrafts from '@/components/email/useEmailDrafts';
import { emailHtmlText } from '@/lib/email/content.mjs';
import { splitRecipients,recipientKey } from '@/lib/email/recipients.mjs';
import ChatCopilotPanel from './ChatCopilotPanel';

function replyDraft(message,detail,mode){
  const envelope=message.envelope,exclude=new Set(detail.selfAddresses.map(recipientKey));
  const to=splitRecipients(envelope.replyTo||envelope.from).filter(a=>!exclude.has(recipientKey(a)));
  to.forEach(a=>exclude.add(recipientKey(a)));
  const cc=mode==='reply_all'?[...new Set([...(envelope.to||[]),...(envelope.cc||[])].map(recipientKey))].filter(a=>!exclude.has(a)):[];
  return {mode,replyMessageId:message.id,to:to.join(', '),cc:cc.join(', '),bcc:'',subject:`Re: ${String(envelope.subject||detail.mailbox.subject||'').replace(/^(Re:|Fwd:)\s*/i,'')}`.slice(0,998),html:'',text:'',attachments:[],scheduledAt:null};
}
export default function EmailInteractionDetail({interaction,onChanged}) {
  const endpoint=`/api/contact-center/email/${interaction.id}`,canEdit=interaction.state==='active';
  const {detail,drafts,error,change,create,discard,reload,send,refresh}=useEmailDrafts(endpoint,{canEdit,onChanged});
  const [active,setActive]=useState('thread'),[templates,setTemplates]=useState(null),[seed,setSeed]=useState(null),[undo,setUndo]=useState({}),[creating,setCreating]=useState(false),[localError,setLocalError]=useState(''),[expanded,setExpanded]=useState({}),[unread,setUnread]=useState(0);
  const seen=useRef(new Set()),first=useRef(true),activeRef=useRef(active);activeRef.current=active;
  const latest=detail?.messages.findLast(m=>m.sender_role==='customer');
  const activeDraft=drafts.find(d=>d.id===active);
  useEffect(()=>{
    const controller=new AbortController();
    fetch(`${endpoint}/templates`,{signal:controller.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load templates');return d;}).then(d=>setTemplates(d.data||[])).catch(e=>{if(!controller.signal.aborted){setTemplates([]);setLocalError(e.message);}});
    return()=>controller.abort();
  },[endpoint]);
  useEffect(()=>{
    if(!detail)return;
    const added=detail.messages.filter(m=>!seen.current.has(m.id));
    if(first.current){first.current=false;if(latest)setExpanded({[latest.id]:true});}
    else if(added.length){
      setExpanded(current=>({...current,...Object.fromEntries(added.map(m=>[m.id,true]))}));
      if(activeRef.current!=='thread')setUnread(n=>n+added.filter(m=>m.sender_role==='customer').length);
    }
    seen.current=new Set(detail.messages.map(m=>m.id));
  },[detail,latest]);
  useEffect(()=>{if(active!=='thread'&&!drafts.some(d=>d.id===active))setActive('thread');},[active,drafts]);
  async function openComposer(mode,message=latest){
    if(!canEdit||!message||creating)return null;
    if(mode!=='forward'){
      const existing=drafts.find(d=>d.content.replyMessageId===message.id&&d.content.mode===mode);
      if(existing){setActive(existing.id);return existing.id;}
    }
    setCreating(true);setLocalError('');
    try{
      let content;
      if(mode==='forward'){
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare_forward',messageId:message.id})});
        const data=await response.json();if(!response.ok)throw Error(data.error||'Unable to prepare forward');content=data.content;content.html=serializeComposerHtml(sanitizeEmailTemplateHtml(content.html,{images:true,remote:detail.preview?.loadRemoteImages===true}));
      }else content=replyDraft(message,detail,mode);
      const id=create(content);setActive(id);return id;
    }catch(e){setLocalError(e.message);return null;}finally{setCreating(false);}
  }
  async function closeDraft(row){
    if(!window.confirm('Discard this unsent draft and close its tab?'))return;
    try{await discard(row.id);}catch(e){setLocalError(e.message);}
  }
  async function cancelScheduled(messageId){
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cancel_scheduled',messageId})});
      const data=await response.json();if(!response.ok)throw Error(data.error);await refresh();
    }catch(e){setLocalError(e.message);}
  }
  async function insertCopilotReply(text){
    const id=activeDraft?.id||await openComposer('reply');if(!id)return;
    const current=drafts.find(d=>d.id===id)?.content||replyDraft(latest,detail,'reply');
    setUndo(values=>({...values,[id]:{html:current.html,text:current.text}}));
    const quote=current.mode==='forward'?new DOMParser().parseFromString(current.html,'text/html').querySelector('blockquote[data-email-forward]')?.outerHTML:'';
    const html=textToEmailHtml(text)+(quote?`<br><br>${quote}`:'');change(id,{text:quote?emailHtmlText(html):text,html});
  }
  const actions=message=><div className="flex shrink-0 items-center gap-1">{[['reply',Reply,'Reply'],['reply_all',ReplyAll,'Reply all'],['forward',Forward,'Forward']].map(([mode,Icon,label])=><Button key={mode} size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" disabled={!canEdit||creating} onClick={()=>void openComposer(mode,message)}><Icon className="size-3.5"/>{label}</Button>)}</div>;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="email-interaction-detail">
    {(error||localError)&&<div role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{localError||error}{error&&<Button size="sm" variant="ghost" onClick={()=>void refresh()}>Retry</Button>}</div>}
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,1fr)_minmax(260px,30%)] overflow-x-auto xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 border-b bg-amber-500/[0.04] px-4 py-3"><Mail className="size-5 shrink-0 text-amber-500"/><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{detail?.mailbox?.subject||interaction.attributes?.subject||'Email interaction'}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{detail?.mailbox?.address||interaction.attributes?.mailbox} · {interaction.queue_name||'Contact Center'}</p></div></div>
        <div role="tablist" aria-label="Email thread and drafts" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 pt-1" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const tabs=[...e.currentTarget.querySelectorAll('[role=tab]')],i=tabs.indexOf(document.activeElement);if(i<0)return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();}}>
          <button role="tab" id="email-tab-thread" aria-controls="email-panel-thread" aria-selected={active==='thread'} tabIndex={active==='thread'?0:-1} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-semibold ${active==='thread'?'border-amber-500 text-amber-600 dark:text-amber-300':'border-transparent text-muted-foreground'}`} onClick={()=>{setActive('thread');setUnread(0);}}>Thread {unread>0&&<span className="ml-1 rounded-full bg-amber-500 px-1.5 text-black">{unread} new</span>}</button>
          {drafts.map(row=><div key={row.id} className={`flex shrink-0 items-center border-b-2 ${active===row.id?'border-amber-500':'border-transparent'}`}><button role="tab" id={`email-tab-${row.id}`} aria-controls={`email-panel-${row.id}`} aria-selected={active===row.id} tabIndex={active===row.id?0:-1} className="max-w-52 truncate px-3 py-2 text-xs" onClick={()=>setActive(row.id)} title={row.content.to||'Draft'}>{row.content.mode==='forward'?'Forward':row.content.mode==='reply_all'?'Reply all':'Reply'} · {row.content.to||'Draft'}{row.dirty?' •':''}</button><button className="mr-1 rounded p-1 hover:bg-muted disabled:opacity-30" aria-label={`Close ${row.content.mode==='forward'?'forward':'reply'} draft to ${row.content.to||'new recipient'}`} disabled={!canEdit||row.sending||row.discarding||Boolean(row.pending||row.submittedMessageId)} onClick={()=>void closeDraft(row)}><X className="size-3"/></button></div>)}
        </div>
        <section role="tabpanel" id="email-panel-thread" aria-labelledby="email-tab-thread" hidden={active!=='thread'} className={active==='thread'?'flex min-h-0 flex-1 flex-col overflow-hidden':'hidden'}>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2"><span className="text-xs text-muted-foreground">Conversation{detail&&` · ${detail.messages.length} messages`}</span>{latest&&actions(latest)}</div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-muted/10 p-3" data-testid="email-thread">
            {!detail&&!error&&<div role="status" aria-label="Loading email conversation" className="flex flex-1 flex-col gap-3"><Skeleton className="h-8 w-64"/><Skeleton className="min-h-64 flex-1"/></div>}
            {detail?.messages.map(message=><article key={message.id} className={`flex shrink-0 flex-col overflow-hidden rounded-xl border bg-background ${expanded[message.id]?'min-h-[360px] flex-1':''} ${message.sender_role==='agent'?'border-amber-500/30':''}`}>
              <div className="flex shrink-0 items-center justify-between gap-2 p-3"><button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={Boolean(expanded[message.id])} onClick={()=>setExpanded(v=>({...v,[message.id]:!v[message.id]}))}><ChevronDown className={`size-4 shrink-0 transition-transform ${expanded[message.id]?'':'-rotate-90'}`}/><span className="min-w-0"><span className="block truncate text-xs font-semibold">{message.envelope.from}</span><span className="block truncate text-[10px] text-muted-foreground">{message.envelope.subject}</span></span></button><EmailMessageStatus message={message}/><time className="shrink-0 text-[10px] text-muted-foreground" title={new Date(message.created_at).toLocaleString()}>{new Date(message.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>{message.sender_role==='customer'&&<Button size="icon" variant="ghost" className="size-7 text-violet-500" aria-label="Ask Copilot about this email" onClick={()=>setSeed({text:message.body||message.envelope.subject,key:Date.now()})}><Brain className="size-4"/></Button>}</div>
              {expanded[message.id]&&<div className="flex min-h-0 flex-1 flex-col gap-2 border-t p-3"><div className="flex shrink-0 flex-wrap items-center justify-between gap-2"><p className="break-all text-[10px] text-muted-foreground">To: {message.envelope.to?.join(', ')}{message.envelope.cc?.length>0&&` · CC: ${message.envelope.cc.join(', ')}`}</p>{message.sender_role==='customer'&&message.id!==latest?.id&&actions(message)}</div><EmailBody message={message} settings={detail.preview} fill/>
                {message.attachments.length>0&&<div className="shrink-0"><EmailAttachments files={message.attachments}/></div>}
                {message.sender_role==='agent'&&(message.deliveries.length>0||message.status==='scheduled')&&<div className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-2 text-[10px] text-muted-foreground">{message.deliveries.map(d=><span key={d.recipient_id}>{d.kind==='bcc'?'BCC recipient':d.address||'Recipient'} · {d.status}</span>)}{message.status==='scheduled'&&<Button variant="ghost" size="sm" disabled={!canEdit} onClick={()=>void cancelScheduled(message.id)}>Cancel scheduled send</Button>}</div>}
              </div>}
            </article>)}
          </div>
        </section>
        {creating&&<div role="status" aria-label="Preparing email draft" className="shrink-0 space-y-2 border-t p-3"><Skeleton className="h-5 w-48"/><Skeleton className="h-10 w-full"/></div>}
        {detail&&drafts.map(row=><EmailDraftComposer key={row.id} row={row} active={active===row.id} workItemId={interaction.id} endpoint={endpoint} detail={detail} templates={templates||[]} templatesLoading={templates===null} canEdit={canEdit} onChange={patch=>change(row.id,patch)} onSend={()=>void send(row.id)} onReload={()=>void reload(row.id)} undo={undo[row.id]} onUndo={()=>{change(row.id,undo[row.id]);setUndo(values=>({...values,[row.id]:null}));}}/>)}
      </div>
      <aside aria-label="Email AI Copilot" className="flex min-h-0 flex-col overflow-hidden border-l bg-muted/10"><div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-xs font-semibold"><Brain className="size-4 text-violet-500"/>AI Copilot</div><ChatCopilotPanel channel="email" workItemId={interaction.id} seed={seed} canInsert={canEdit&&!creating&&!activeDraft?.pending&&!activeDraft?.submittedMessageId&&!activeDraft?.sending&&Boolean(latest)} onInsert={text=>void insertCopilotReply(text)}/></aside>
    </div>
  </div>;
}
