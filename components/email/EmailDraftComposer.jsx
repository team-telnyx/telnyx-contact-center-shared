"use client";
import { useCallback,useRef,useState } from 'react';
import { Clock,Paperclip,Send,Undo2,X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { RichEmailEditor } from './RichEmailEditor';
import EmailRecipients from './EmailRecipients';
import { sanitizeEmailTemplateHtml } from './template-html';
import { textToEmailHtml } from './EmailBody';
import { splitRecipients,validRecipient } from '@/lib/email/recipients.mjs';
import { EMAIL_SEND_REQUEST_BYTES,draftSendPayload,emailEncodedBytes,emailSendSizeError } from '@/lib/email/send-limits.mjs';
import { emailHtmlText } from '@/lib/email/content.mjs';

export function serializeComposerHtml(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  for(const img of doc.querySelectorAll('img[data-email-src]')){img.setAttribute('src',img.getAttribute('data-email-src'));img.removeAttribute('data-email-src');}
  return doc.body.innerHTML;
}
export default function EmailDraftComposer({row,active,workItemId,endpoint,detail,templates,templatesLoading,canEdit,onChange,onSend,onReload,undo,onUndo}) {
  const draft=row.content,locked=!canEdit||row.sending||row.discarding||Boolean(row.pending||row.submittedMessageId);
  const [recipients,setRecipients]=useState(Boolean(draft.cc||draft.bcc)),[schedule,setSchedule]=useState(Boolean(draft.scheduledAt)),[templateInput,setTemplateInput]=useState(null),[templateBusy,setTemplateBusy]=useState(false),[localError,setLocalError]=useState('');
  const input=useRef(null),content=useRef(draft);content.current=draft;
  const sanitize=useCallback(html=>sanitizeEmailTemplateHtml(html,{images:true,remote:detail.preview?.loadRemoteImages===true}),[detail.preview?.loadRemoteImages]);
  const participants=[...new Set(detail.messages.filter(m=>m.sender_role==='customer').flatMap(m=>[m.envelope.from,...splitRecipients(m.envelope.replyTo),...(m.envelope.to||[]),...(m.envelope.cc||[])]))].filter(a=>!detail.selfAddresses.includes(a));
  const scheduledDate=draft.scheduledAt?new Date(draft.scheduledAt):null;
  const scheduledLocal=scheduledDate&&Number.isFinite(scheduledDate.getTime())?new Date(scheduledDate.getTime()-scheduledDate.getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  async function attach(files){
    try{
      const added=await Promise.all([...files].map(file=>new Promise((resolve,reject)=>{
        if(file.size>5_000_000)return reject(Error('Attachments must total at most 5 MB'));
        const reader=new FileReader();reader.onerror=()=>reject(Error('Unable to read attachment'));
        reader.onload=()=>resolve({filename:file.name,content_type:file.type||'application/octet-stream',content:String(reader.result).split(',')[1],size_bytes:file.size});reader.readAsDataURL(file);
      })));
      const attachments=[...(content.current.attachments||[]),...added];
      if(attachments.length>20||attachments.reduce((n,a)=>n+(a.size_bytes??a.content.length*0.75),0)>5_000_000)throw Error('Attach at most 20 files, totalling 5 MB');
      onChange({attachments});setLocalError('');
    }catch(e){setLocalError(e.message);}
  }
  async function renderTemplate(value){
    setTemplateBusy(true);
    try{
      const response=await fetch(`${endpoint}/templates`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),data=await response.json();if(!response.ok)throw Error(data.error);
      const result=data.data||data;onChange({subject:result.subject||content.current.subject,html:result.html_body||textToEmailHtml(result.text_body),text:result.text_body||emailHtmlText(result.html_body)});setTemplateInput(null);setLocalError('');
    }catch(e){setLocalError(e.message);}finally{setTemplateBusy(false);}
  }
  async function insertTemplate(id){
    if(!id)return;setTemplateBusy(true);
    try{
      const response=await fetch(`${endpoint}/templates?id=${encodeURIComponent(id)}`),data=await response.json();if(!response.ok)throw Error(data.error);
      const value=data.data,names=[...new Set([...(value.variables||[]).filter(n=>typeof n==='string'),...[...`${value.subject||''} ${value.html_body||''} ${value.text_body||''}`.matchAll(/{{\s*([a-zA-Z_][\w.]*)/g)].map(m=>m[1])])];
      if(names.length)setTemplateInput({id,variables:Object.fromEntries(names.map(name=>[name,'']))});else await renderTemplate({id,variables:{}});
    }catch(e){setLocalError(e.message);}finally{setTemplateBusy(false);}
  }
  const estimatedBytes=emailEncodedBytes(draftSendPayload(draft,detail.mailbox.address));
  const controls=<div className="space-y-2">
    <div className="flex flex-wrap items-center gap-1"><input ref={input} type="file" multiple className="hidden" disabled={locked} onChange={e=>{void attach(e.target.files);e.target.value='';}}/>
      <Button size="sm" variant="ghost" disabled={locked} onClick={()=>input.current.click()}><Paperclip className="mr-1 size-4"/>Attach files</Button>
      <Button size="sm" variant={schedule?'secondary':'ghost'} disabled={locked} onClick={()=>{setSchedule(v=>!v);if(schedule)onChange({scheduledAt:null});}}><Clock className="mr-1 size-4"/>Schedule</Button>
      <span className="text-[10px] text-muted-foreground">Up to 20 files · 5 MB attachments · 1 MB text + HTML</span>
      {undo&&<Button variant="ghost" size="sm" disabled={locked} onClick={onUndo}><Undo2 className="mr-1 size-3"/>Undo inserted reply</Button>}
    </div>
    <p className="text-[10px] text-muted-foreground">Estimated message size including encoding: {Math.ceil(estimatedBytes/1000)} / {EMAIL_SEND_REQUEST_BYTES/1000} KB</p>
    {draft.attachments?.length>0&&<div className="flex max-h-20 flex-wrap gap-2 overflow-y-auto">{draft.attachments.map((file,i)=><span key={i} className="flex max-w-full items-center gap-1 rounded bg-muted px-2 py-1 text-xs"><Paperclip className="size-3 shrink-0"/><span className="truncate">{file.filename}</span><button disabled={locked} aria-label={`Remove ${file.filename}`} onClick={()=>onChange({attachments:draft.attachments.filter((_,n)=>i!==n)})}><X className="size-3"/></button></span>)}</div>}
    {schedule&&<Input type="datetime-local" aria-label="Schedule email" disabled={locked} value={scheduledLocal} onChange={e=>onChange({scheduledAt:e.target.value?new Date(e.target.value).toISOString():null})}/>}
  </div>;
  const sendPayload=draftSendPayload(draft,detail.mailbox.address),sizeError=!row.pending&&!row.submittedMessageId?emailSendSizeError(sendPayload):'';
  const invalid=['to','cc','bcc'].some(field=>splitRecipients(draft[field]).some(email=>!validRecipient(email)));
  return <section role="tabpanel" id={`email-panel-${row.id}`} aria-labelledby={`email-tab-${row.id}`} hidden={!active} className={active?'flex min-h-0 flex-1 flex-col overflow-hidden':'hidden'} data-testid="email-composer">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2"><div><h3 className="text-sm font-semibold">{draft.mode==='forward'?'Forward':draft.mode==='reply_all'?'Reply all':'Reply'}</h3><p role="status" className="text-[10px] text-muted-foreground">{row.pending||row.submittedMessageId?'Sending — awaiting confirmation':row.saving?'Saving…':row.dirty?'Unsaved changes':'Draft saved'}</p></div>
      <Button size="sm" className="gap-2 bg-amber-600 text-white hover:bg-amber-700" disabled={!canEdit||row.sending||Boolean(row.submittedMessageId)||!detail.mailbox.sending_enabled||row.conflict||invalid||Boolean(sizeError)||!draft.to.trim()||!draft.subject.trim()||!(draft.text.trim()||emailHtmlText(draft.html)||/<img\b/i.test(draft.html))} onClick={onSend}><Send className="size-4"/>{row.pending?'Confirm send':draft.scheduledAt?'Schedule':draft.mode==='forward'?'Send forward':'Send reply'}</Button>
    </div>
    {(sizeError||row.error||localError)&&<div role="alert" className="shrink-0 px-4 py-2 text-xs text-destructive">{sizeError||row.error||localError}{row.conflict&&<Button variant="outline" size="sm" onClick={()=>{if(window.confirm('Replace this tab with its saved version? Unsaved edits will be discarded.'))onReload();}}>Reload saved draft</Button>}</div>}
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="shrink-0 space-y-2">
        <EmailRecipients workItemId={workItemId} field="to" draft={draft} participants={participants} onChange={to=>onChange({to})} disabled={locked}/>
        {(recipients||draft.cc||draft.bcc)&&['cc','bcc'].map(field=><EmailRecipients key={field} workItemId={workItemId} field={field} draft={draft} participants={participants} onChange={value=>onChange({[field]:value})} disabled={locked}/>)}
        <div className="flex items-center gap-2"><label htmlFor={`subject-${row.id}`} className="w-10 shrink-0 text-xs text-muted-foreground">Subject</label><Input id={`subject-${row.id}`} value={draft.subject} onChange={e=>onChange({subject:e.target.value})} disabled={locked} className="h-8 text-xs"/></div>
        <div className="flex items-center justify-between gap-2">{templatesLoading?<Skeleton aria-label="Loading templates" className="h-7 w-40"/>:<select aria-label="Email template" className="max-w-52 rounded-md border bg-background px-2 py-1 text-xs" disabled={locked||templateBusy||templates.length===0} value="" onChange={e=>void insertTemplate(e.target.value)}><option value="">{templateBusy?'Loading template…':templates.length?'Use a template':'No templates'}</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>}<Button variant="ghost" size="sm" className="h-7 text-xs" onClick={()=>setRecipients(v=>!v)}>CC / BCC</Button></div>
        {templateInput&&<div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border p-2"><p className="text-xs font-medium">Template variables</p>{Object.entries(templateInput.variables).map(([name,value])=><label key={name} className="flex items-center gap-2 text-xs">{name}<Input value={value} onChange={e=>setTemplateInput({...templateInput,variables:{...templateInput.variables,[name]:e.target.value}})}/></label>)}<Button size="sm" disabled={locked||templateBusy} onClick={()=>void renderTemplate(templateInput)}>Insert template</Button></div>}
      </div>
      <RichEmailEditor value={draft.html} onChange={html=>onChange({html,text:emailHtmlText(html)})} sanitizeHtml={sanitize} serializeHtml={serializeComposerHtml} disabled={locked} minHeight={100} className="min-h-0 flex-1" toolbarExtra={controls}/>
    </div>
  </section>;
}
