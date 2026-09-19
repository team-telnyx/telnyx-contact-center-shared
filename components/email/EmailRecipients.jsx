"use client";
import { useEffect,useId,useState } from 'react';
import { BookUser,X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { addRecipients,splitRecipients,recipientKey,validRecipient } from '@/lib/email/recipients.mjs';

function useContacts(workItemId,query,page,enabled,pageSize=20) {
  const [result,setResult]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const key=JSON.stringify([workItemId,query,page,pageSize,retry]);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try{
        const params=new URLSearchParams({workItemId,q:query,page:String(page),pageSize:String(pageSize)});
        const response=await fetch(`/api/contact-center/email/recipients?${params}`,{signal:controller.signal,cache:'no-store'});
        const data=await response.json();if(!response.ok)throw Error(data.error||'Unable to load contacts');
        if(!controller.signal.aborted){setError('');setResult({key,...data});}
      }catch(e){if(!controller.signal.aborted){setError(e.message);setResult({key,data:[],total:0});}}
    },250);
    return()=>{clearTimeout(timer);controller.abort();};
  },[workItemId,query,page,pageSize,retry,enabled,key]);
  return {data:result?.key===key?result.data:[],total:result?.key===key?result.total:0,loading:enabled&&result?.key!==key,error:result?.key===key?error:'',retry:()=>setRetry(v=>v+1)};
}
function LoadingContacts(){return <div role="status" aria-label="Loading contacts" className="space-y-3 p-3">{[0,1,2].map(i=><div key={i} className="space-y-2"><Skeleton className="h-4 w-40"/><Skeleton className="h-3 w-56"/></div>)}</div>;}
function AddressBook({workItemId,field,onAdd,onClose}) {
  const [query,setQuery]=useState(''),[page,setPage]=useState(1),[selected,setSelected]=useState({});
  const contacts=useContacts(workItemId,query,page,true);
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="sm:max-w-2xl">
    <DialogHeader><DialogTitle>Add recipients to {field.toUpperCase()}</DialogTitle><DialogDescription>Select email addresses from your Contact Center contacts.</DialogDescription></DialogHeader>
    <Input aria-label="Search email contacts" placeholder="Search by name, company or email" value={query} onChange={e=>{setQuery(e.target.value);setPage(1);}}/>
    <div className="h-80 overflow-y-auto rounded-lg border">
      {contacts.loading?<LoadingContacts/>:contacts.error?<div role="alert" className="p-4 text-sm">{contacts.error}<Button variant="outline" onClick={contacts.retry}>Retry</Button></div>:contacts.data.length===0?<p className="p-5 text-sm text-muted-foreground">{query?'No matching contacts.':'No contacts with an email address.'}</p>:contacts.data.map(contact=><label key={`${contact.contact_id}:${contact.email}`} className="flex cursor-pointer items-center gap-3 border-b p-3 last:border-0 hover:bg-muted/50"><input type="checkbox" checked={Boolean(selected[contact.email])} onChange={e=>setSelected(v=>({...v,[contact.email]:e.target.checked}))}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{contact.name}</span><span className="block break-all text-xs text-muted-foreground">{contact.email} · {contact.position===1?'Primary':'Secondary'}{contact.company&&` · ${contact.company}`}</span></span></label>)}
    </div>
    <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page===1||contacts.loading} onClick={()=>setPage(p=>p-1)}>Previous</Button><span className="text-xs">Page {page}</span><Button variant="outline" size="sm" disabled={contacts.loading||page*20>=contacts.total} onClick={()=>setPage(p=>p+1)}>Next</Button></div><Button disabled={!Object.values(selected).some(Boolean)} onClick={()=>{onAdd(Object.keys(selected).filter(k=>selected[k]));onClose();}}>Add {Object.values(selected).filter(Boolean).length} recipients to {field.toUpperCase()}</Button></div>
  </DialogContent></Dialog>;
}
export default function EmailRecipients({workItemId,field,draft,onChange,participants=[],disabled=false}) {
  const id=useId(),[input,setInput]=useState(''),[focused,setFocused]=useState(false),[book,setBook]=useState(false),[highlight,setHighlight]=useState(0),[notice,setNotice]=useState('');
  const values=splitRecipients(draft[field]);
  const contacts=useContacts(workItemId,input,1,focused&&input.trim().length>=2&&!disabled,8);
  const keys=new Set(['to','cc','bcc'].flatMap(f=>splitRecipients(draft[f]).map(recipientKey)));
  const seen=new Set();
  const suggestions=[...participants.filter(email=>validRecipient(email)&&email.toLowerCase().includes(input.toLowerCase())).map(email=>({email,name:email,company:'In this conversation'})),...contacts.data].filter(c=>{const key=recipientKey(c.email);if(keys.has(key)||seen.has(key))return false;seen.add(key);return true;}).slice(0,8);
  const expanded=focused&&input.trim().length>=2&&!disabled;
  function add(items){
    const result=addRecipients(draft,field,items);onChange(result.value);setInput('');setHighlight(0);
    setNotice(result.duplicates.length?`${result.duplicates[0].address} is already in ${result.duplicates[0].field.toUpperCase()}. Remove it there to move it.`:'');
  }
  function commit(){if(input.trim())add(splitRecipients(input));}
  return <div className="min-w-0 space-y-1">
    <div className="flex items-start gap-2"><label htmlFor={id} className="w-10 shrink-0 pt-2 text-xs uppercase text-muted-foreground">{field}</label><div className="relative min-w-0 flex-1">
      <div className={`flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-background p-1 ${disabled?'opacity-60':''}`}>
        {values.map((email,index)=><span key={`${email}:${index}`} title={validRecipient(email)?email:'Invalid email address'} className={`flex max-w-full items-center gap-1 rounded px-2 py-1 text-xs ${validRecipient(email)?'bg-muted':'bg-destructive/10 text-destructive'}`}><span className="truncate">{email}</span><button type="button" disabled={disabled} aria-label={`Remove ${email} from ${field.toUpperCase()}`} onClick={()=>onChange(values.filter((_,i)=>i!==index).join(', '))}><X className="size-3"/></button></span>)}
        <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-options`} aria-activedescendant={expanded&&suggestions[highlight]?`${id}-option-${highlight}`:undefined} className="min-w-24 flex-1 bg-transparent px-1 py-1 text-xs outline-none" placeholder={values.length?'Add recipient…':'Name or email address'} value={input} disabled={disabled}
          onFocus={()=>setFocused(true)} onBlur={()=>{setFocused(false);commit();}}
          onChange={e=>{const value=e.target.value;setHighlight(0);if(/[,;\n]/.test(value))add(splitRecipients(value));else setInput(value);}}
          onPaste={e=>{const value=e.clipboardData.getData('text/plain');if(/[,;\n]/.test(value)){e.preventDefault();add(splitRecipients(input+value));}}}
          onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setHighlight(i=>Math.max(0,Math.min(suggestions.length-1,i+(e.key==='ArrowDown'?1:-1))));}else if(e.key==='Enter'){e.preventDefault();if(expanded&&suggestions[highlight])add([suggestions[highlight].email]);else commit();}else if(e.key==='Escape'){e.preventDefault();setFocused(false);}else if(e.key==='Backspace'&&!input&&values.length){onChange(values.slice(0,-1).join(', '));}}}/>
      </div>
      {expanded&&<div id={`${id}-options`} role="listbox" aria-label="Email suggestions" className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border bg-popover shadow-xl" onMouseDown={e=>e.preventDefault()}>
        {suggestions.map((c,i)=><button type="button" role="option" aria-selected={highlight===i} id={`${id}-option-${i}`} key={c.email} className={`block w-full px-3 py-2 text-left text-xs hover:bg-muted ${highlight===i?'bg-muted':''}`} onClick={()=>add([c.email])}><span className="block font-medium">{c.name}</span><span className="block break-all text-muted-foreground">{c.email}{c.company&&` · ${c.company}`}</span></button>)}
        {contacts.loading?<LoadingContacts/>:contacts.error?<p role="alert" className="p-3 text-xs">{contacts.error} <button type="button" onClick={contacts.retry}>Retry</button></p>:suggestions.length===0&&<p className="p-3 text-xs text-muted-foreground">No matching contacts. Press Enter to use the typed address.</p>}
      </div>}
    </div><Button type="button" size="icon" variant="outline" className="size-9 shrink-0" disabled={disabled} aria-label={`Open address book for ${field.toUpperCase()}`} onClick={()=>setBook(true)}><BookUser className="size-4"/></Button></div>
    {notice&&<p role="status" className="pl-12 text-xs text-amber-600">{notice}</p>}
    {values.some(email=>!validRecipient(email))&&<p role="alert" className="pl-12 text-xs text-destructive">Correct the highlighted email addresses before sending.</p>}
    {book&&<AddressBook workItemId={workItemId} field={field} onAdd={add} onClose={()=>setBook(false)}/>}
  </div>;
}
