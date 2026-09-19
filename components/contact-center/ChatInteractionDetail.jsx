"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import dynamic from "next/dynamic";
import { Ban,Bot,Clock,Contact,FileText,Image as ImageIcon,LayoutTemplate,Loader2,MapPin,MessageCircle,MessageSquare,Paperclip,Send,Smile,Sticker,Undo2,X } from "lucide-react";
import { IconBrandWhatsapp } from "@tabler/icons-react";
import { smsSegments } from "@/lib/sms/segments.mjs";
import { SMS_MAX_BODY_CHARS } from "@/lib/sms/policy.mjs";
import { utf8Bytes,validateWhatsAppMedia,whatsappMediaKind,WHATSAPP_MAX_FILES,WHATSAPP_MAX_TEXT_BYTES } from "@/lib/whatsapp/policy.mjs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover";
import ChatMessageBubble,{ChatAvatar} from "./ChatMessageBubble";
import ChatContextPanel from "./ChatContextPanel";
import PexelsPickerDialog from "./PexelsPickerDialog";
import WhatsAppTemplateDialog from "./WhatsAppTemplateDialog";
import WhatsAppLocationDialog from "./WhatsAppLocationDialog";
import WhatsAppContactDialog from "./WhatsAppContactDialog";
import { fileSize } from "./ChatAttachments";
import { useChatComposer } from "./chat-composer-store";
import { MAX_CHAT_FILES,MAX_CHAT_FILE_BYTES } from "@/lib/contact-center/chat-compose-limits.mjs";
import { attachmentAccept,isAttachmentTypeAllowed } from "@/lib/widgets/attachment-types.mjs";

const EmojiPickerPanel=dynamic(()=>import("@/components/messaging/EmojiPickerPanel"),{ssr:false,
  loading:()=> <div role="status" aria-label="Loading emojis" className="w-[300px] max-w-full space-y-3 p-2"><Skeleton className="h-6 w-24"/><Skeleton className="h-9 w-full"/><Skeleton className="h-64 w-full"/></div>});

const TONES={chat:{header:"bg-teal-500/[0.04]",pill:"border-teal-500/20 bg-teal-500/5 text-teal-700 dark:text-teal-300",dot:"bg-teal-500",send:"bg-teal-600 hover:bg-teal-700"},
  sms:{header:"bg-sky-500/[0.04]",pill:"border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-300",dot:"bg-sky-500",send:"bg-sky-600 hover:bg-sky-700"},
  whatsapp:{header:"bg-green-600/[0.05]",pill:"border-green-600/20 bg-green-600/5 text-green-700 dark:text-green-300",dot:"bg-green-600",send:"bg-green-600 hover:bg-green-700"}};
function remaining(expiresAt,now=Date.now()){
  const ms=Math.max(0,Date.parse(expiresAt||0)-now);const hours=Math.floor(ms/3600000),minutes=Math.floor((ms%3600000)/60000);
  return hours>0?`${hours} h ${minutes} min`:`${minutes} min`;
}

export default function ChatInteractionDetail({interaction,onChanged,composeStore}){
  const [detail,setDetail]=useState(null),[draft,setDraft]=useState(""),[draftConflict,setDraftConflict]=useState(null);
  const [error,setError]=useState("");
  const [compose,store]=useChatComposer(interaction.id,composeStore);
  const busy=compose.sending,locked=busy||Boolean(compose.pending);
  const lastSent=useRef(compose.lastSent);
  const [emojiOpen,setEmojiOpen]=useState(false),[pexelsOpen,setPexelsOpen]=useState(false),[templateOpen,setTemplateOpen]=useState(false);
  const [locationOpen,setLocationOpen]=useState(false),[contactOpen,setContactOpen]=useState(false);
  const emojiInserted=useRef(false);
  const initialized=useRef(false),draftVersion=useRef("0"),savedDraft=useRef(""),savingDraft=useRef(null);
  const bottom=useRef(null),typingAt=useRef(0),request=useRef(null);
  const fileInput=useRef(null),composer=useRef(null);
  const [copilotSeed,setCopilotSeed]=useState(null),[undoDraft,setUndoDraft]=useState(null);
  const channel=interaction.channel||"chat",sms=channel==="sms",whatsapp=channel==="whatsapp",provider=sms||whatsapp;
  const tone=TONES[channel]||TONES.chat;
  const endpoint=`/api/contact-center/${channel}/${interaction.id}`;
  const cacheKey=`cc-${channel}-draft:${interaction.id}`;
  const maxLength=sms?SMS_MAX_BODY_CHARS:whatsapp?WHATSAPP_MAX_TEXT_BYTES:20000;
  const segments=sms?smsSegments(draft):null;
  const textBytes=whatsapp?utf8Bytes(draft):0;
  const offered=interaction.state==="ringing",wrapup=interaction.state==="wrapup";
  useEffect(()=>{
    if(compose.lastSent===lastSent.current)return;
    lastSent.current=compose.lastSent;
    setDraft("");setUndoDraft(null);savedDraft.current="";
    if(compose.lastSent?.draftVersion)draftVersion.current=compose.lastSent.draftVersion;
  },[compose.lastSent]);
  const refresh=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try{
      const response=await fetch(endpoint,{cache:"no-store",signal:controller.signal});const body=await response.json();
      if(!response.ok)throw new Error(body.error||"Unable to load conversation");
      if(controller.signal.aborted)return;
      setDetail(body);
      if(!initialized.current){
        if(BigInt(body.draft.version)<BigInt(draftVersion.current))return;
        initialized.current=true;savedDraft.current=body.draft.body;draftVersion.current=String(body.draft.version);
        let cached=null;try{cached=JSON.parse(sessionStorage.getItem(cacheKey)||"null");}catch{}
        setDraft(cached?.body ?? body.draft.body);
        if(cached && String(cached.version)!==String(body.draft.version) && cached.body!==body.draft.body){
          setDraftConflict(body.draft);
          setError("A saved draft changed in another session. Your unsent text has been recovered; review it before sending.");
        }
      }
    }catch(reason){if(reason.name!=="AbortError")setError(reason.message);}
  },[endpoint,cacheKey]);
  useEffect(()=>{
    void refresh();
    const timer=setInterval(()=>void refresh(),2000);
    window.addEventListener("contact-center:acd-state",refresh);
    window.addEventListener("contact-center:chat-changed",refresh);
    return()=>{clearInterval(timer);request.current?.abort();window.removeEventListener("contact-center:acd-state",refresh);window.removeEventListener("contact-center:chat-changed",refresh);};
  },[refresh]);
  useEffect(()=>{bottom.current?.scrollIntoView({block:"end"});},[detail?.messages.length]);

  const persistDraft=useCallback(async(value)=>{
    if(savingDraft.current)await savingDraft.current;
    if(value===savedDraft.current)return;
    const pending=(async()=>{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"draft",body:value,expectedDraftVersion:draftVersion.current})});
      const body=await response.json();if(!response.ok)throw new Error(body.error);
      draftVersion.current=String(body.version);savedDraft.current=value;
      try{const cached=JSON.parse(sessionStorage.getItem(cacheKey)||"null");
        if(cached?.body===value)sessionStorage.removeItem(cacheKey);
        else if(cached)sessionStorage.setItem(cacheKey,JSON.stringify({...cached,version:body.version}));
      }catch{}
    })();
    savingDraft.current=pending;
    try{await pending;}finally{if(savingDraft.current===pending)savingDraft.current=null;}
  },[endpoint,cacheKey]);
  useEffect(()=>{
    if(!initialized.current||offered||wrapup||locked||draftConflict||draft===savedDraft.current)return;
    const timer=setTimeout(()=>void persistDraft(draft).catch(reason=>setError(reason.message)),600);
    return()=>clearTimeout(timer);
  },[draft,offered,wrapup,locked,draftConflict,persistDraft]);

  async function complete(pending,result){
    if(!result){
      let response;
      if(pending.files.length){
        const body=new FormData();body.set("message",JSON.stringify(pending.message));
        for(const {file} of pending.files)body.append("file",file);
        response=await fetch(`${endpoint}/messages`,{method:"POST",body});
      }else response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending.message)});
      result=await response.json();
      if(!response.ok){if(response.status<500)store.update(interaction.id,{pending:null});throw Error(result.error||"Unable to send message");}
    }
    try{sessionStorage.removeItem(cacheKey);}catch{}
    store.update(interaction.id,{files:[],pending:null,lastSent:{...result,commandId:pending.message.commandId}});
    window.dispatchEvent(new CustomEvent("contact-center:chat-changed"));
    onChanged?.();await refresh();
  }
  async function send(){
    const current=store.get(interaction.id);
    if(current.sending||(!current.pending&&(!detail||draftConflict||(!draft.trim()&&!current.files.length)||(sms&&smsSegments(draft).tooLong)||(whatsapp&&textBytes>WHATSAPP_MAX_TEXT_BYTES))))return;
    store.update(interaction.id,{sending:true,error:""});setError("");
    try{
      let pending=current.pending,result;
      if(pending){
        const confirmation=await fetch(`${endpoint}/commands/${encodeURIComponent(pending.message.commandId)}`,{cache:"no-store"});
        const body=await confirmation.json();if(!confirmation.ok)throw Error(body.error||"Unable to confirm the previous send");
        result=body.result;
      }else{
        await persistDraft(draft);
        pending={message:{action:"send",body:draft,commandId:crypto.randomUUID(),expectedVersion:detail.work.version,draftVersion:draftVersion.current,
          ...(whatsapp&&current.files.length?{mediaKinds:current.files.map(item=>item.kind||whatsappMediaKind(item.file.type,item.file.name))}:{})},files:current.files};
        store.update(interaction.id,{pending});
      }
      await complete(pending,result);
    }catch(reason){store.update(interaction.id,{error:reason.message});}finally{store.update(interaction.id,{sending:false});}
  }
  // Structured WhatsApp sends (template, location, contact cards, reaction)
  // go through the JSON command endpoint; the draft stays untouched.
  async function sendStructured(extra,onDone){
    const current=store.get(interaction.id);
    if(current.sending||current.pending||!detail)return;
    store.update(interaction.id,{sending:true,error:""});setError("");
    try{
      const pending={message:{action:"send",body:"",...extra,commandId:crypto.randomUUID(),expectedVersion:detail.work.version,draftVersion:draftVersion.current},files:[]};
      store.update(interaction.id,{pending});
      await complete(pending,null);onDone?.();
    }catch(reason){store.update(interaction.id,{error:reason.message});}finally{store.update(interaction.id,{sending:false});}
  }
  const sendTemplate=template=>sendStructured({template},()=>setTemplateOpen(false));
  const sendLocation=location=>sendStructured({location},()=>setLocationOpen(false));
  const sendContacts=contactIds=>sendStructured({contactIds},()=>setContactOpen(false));
  const react=(message,emoji)=>{if(!locked&&canReply)void sendStructured({reaction:{messageId:message.id,emoji}});};
  function edit(value){
    setDraft(value);
    try{sessionStorage.setItem(cacheKey,JSON.stringify({body:value,version:draftVersion.current}));}catch{}
    if(!provider&&Date.now()-typingAt.current>2500){typingAt.current=Date.now();void fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"typing",typing:Boolean(value.trim())})});}
  }
  const mediaPolicy=whatsapp?detail?.whatsapp?.mediaPolicy:null;
  function selectFiles(selected){
    if(locked)return;
    const files=[...store.get(interaction.id).files,...Array.from(selected||[]).map(file=>({id:crypto.randomUUID(),file,kind:whatsapp?whatsappMediaKind(file.type,file.name):undefined}))];
    if(fileInput.current)fileInput.current.value="";
    if(whatsapp){
      if(files.length>WHATSAPP_MAX_FILES){setError(`Choose up to ${WHATSAPP_MAX_FILES} files per message`);return;}
      for(const item of files){
        if(!item.kind){setError(`${item.file.name} cannot be sent on WhatsApp`);return;}
        try{validateWhatsAppMedia({contentType:item.file.type,byteSize:item.file.size,name:item.file.name},item.kind);}catch(reason){setError(reason.message);return;}
      }
    }else{
      const policy=detail?.attachmentPolicy;
      if(files.length>MAX_CHAT_FILES){setError(`Choose up to ${MAX_CHAT_FILES} attachments per message`);return;}
      if(files.some(({file})=>!file.size||!isAttachmentTypeAllowed(file.type,file.name,policy?.outboundMimeTypes)||file.size>policy.maximumFileSizeMb*1048576)){setError("File type or size is not allowed by this widget");return;}
      if(files.reduce((total,{file})=>total+file.size,0)>MAX_CHAT_FILE_BYTES){setError("Attachments must total at most 100 MB");return;}
    }
    store.update(interaction.id,{files,error:""});setError("");
  }
  function setKind(id,kind){
    const files=store.get(interaction.id).files.map(item=>item.id===id?{...item,kind}:item);
    const item=files.find(entry=>entry.id===id);
    try{if(kind!=="sticker")validateWhatsAppMedia({contentType:item.file.type,byteSize:item.file.size,name:item.file.name},kind);}catch(reason){setError(reason.message);return;}
    store.update(interaction.id,{files,error:""});setError("");
  }
  const optedOut=Boolean(detail?.sms?.opted_out),sendingPaused=(sms&&detail?.sms&&!detail.sms.sending_enabled)||(whatsapp&&detail?.whatsapp&&!detail.whatsapp.sending_enabled);
  const serviceWindow=whatsapp?detail?.whatsapp?.window:null,windowClosed=Boolean(whatsapp&&detail?.whatsapp&&!serviceWindow?.open);
  const tooLong=Boolean(segments?.tooLong)||(whatsapp&&textBytes>WHATSAPP_MAX_TEXT_BYTES);
  const canReply=Boolean(detail)&&!offered&&!wrapup&&!optedOut&&!sendingPaused&&!windowClosed;
  const canTemplate=whatsapp&&Boolean(detail)&&!offered&&!wrapup&&!sendingPaused;
  const thread=sms?detail?.sms:whatsapp?detail?.whatsapp:null;
  const customerName=detail?.customerName||interaction.from_name||(provider?(whatsapp?"WhatsApp customer":"Mobile customer"):"Website visitor");
  const agentName=[detail?.agent?.first_name,detail?.agent?.last_name].filter(Boolean).join(" ")||"You";
  const channelLabel=sms?"SMS":whatsapp?"WhatsApp":"chat";
  function insertSuggestion(text){
    if(!canReply||locked||draftConflict)return;
    setUndoDraft(draft);edit(text);composer.current?.focus();
  }
  function insertEmoji(emoji){
    if(!canReply||locked)return;
    const field=composer.current,start=field?.selectionStart??draft.length,end=field?.selectionEnd??draft.length;
    const value=draft.slice(0,start)+emoji+draft.slice(end);
    if(value.length>maxLength)return;
    edit(value);setUndoDraft(null);emojiInserted.current=true;setEmojiOpen(false);
    requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(start+emoji.length,start+emoji.length);});
  }
  const attachmentsEnabled=whatsapp?Boolean(mediaPolicy?.mimeTypes?.length):Boolean(detail?.attachmentPolicy?.outboundMimeTypes?.length);
  const accept=whatsapp?(mediaPolicy?.mimeTypes||[]).join(","):detail?.attachmentPolicy?attachmentAccept(detail.attachmentPolicy.outboundMimeTypes):"";
  const HeaderIcon=whatsapp?IconBrandWhatsapp:sms?MessageSquare:MessageCircle;
  return <div className="@container flex min-h-0 flex-1 flex-col" data-testid="chat-interaction-detail" data-channel={channel}>
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto bg-muted/20 p-3 @[700px]:grid-cols-2 @[700px]:overflow-hidden" data-testid="chat-desktop-columns">
      <section className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm @[700px]:min-h-0" aria-label="Chat conversation">
        <header className={`flex shrink-0 items-center gap-3 border-b px-4 py-3 ${tone.header}`}>
          <ChatAvatar name={customerName} className="size-10"/>
          <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{customerName}</h3><p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground"><HeaderIcon className="size-3"/>{interaction.queue_name||(provider?channelLabel:"Chat")}{provider&&thread?.business_number&&<><span>·</span><span data-testid={`${channel}-business-number`}>{thread.number_name?`${thread.number_name} ${thread.business_number}`:thread.business_number}</span></>}{provider&&thread?.customer_address&&thread.customer_address!==customerName&&<><span>·</span><span>{thread.customer_address}</span></>}{detail?.work.attributes?.handoff&&<><span>·</span><Bot className="size-3"/><span>AI handoff</span></>}</p></div>
          {optedOut&&<span className="flex shrink-0 items-center gap-1 rounded-full border border-red-500/20 bg-red-500/5 px-2 py-1 text-[10px] font-medium text-red-700 dark:text-red-300" data-testid="sms-opted-out"><Ban className="size-3"/>Opted out</span>}
          {whatsapp&&serviceWindow&&<span className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${serviceWindow.open?"border-green-600/20 bg-green-600/5 text-green-700 dark:text-green-300":"border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300"}`} data-testid="whatsapp-window" data-window-open={String(serviceWindow.open)} title={serviceWindow.open?`The 24-hour customer service window closes ${new Date(serviceWindow.expiresAt).toLocaleString()}`:"Free-form replies need a message from the customer within the last 24 hours"}><Clock className="size-3"/>{serviceWindow.open?`Window ${remaining(serviceWindow.expiresAt)}`:"Window closed"}</span>}
          <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${tone.pill}`}><span className={`size-1.5 rounded-full ${offered?"animate-pulse bg-amber-500":wrapup?"bg-amber-500":tone.dot}`}/>{offered?"Offered":wrapup?"Wrap-up":provider?"Active":"Connected"}</span>
        </header>
        {(error||compose.error)&&<p role="alert" className="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error||compose.error}</p>}
        {draftConflict&&<div className="flex shrink-0 flex-wrap gap-2 border-b p-2">
          <Button variant="outline" size="sm" disabled={locked} onClick={()=>{setDraftConflict(null);setError("");}}>Keep recovered draft</Button>
          <Button variant="outline" size="sm" disabled={locked} onClick={()=>{setDraft(draftConflict.body);setDraftConflict(null);setError("");try{sessionStorage.removeItem(cacheKey);}catch{}}}>Use saved draft</Button>
        </div>}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-muted/[0.16] px-4 py-5" aria-label="Conversation messages" aria-live="polite">
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground"><span className="h-px flex-1 bg-border/60"/><span>{new Date(interaction.created_at||Date.now()).toLocaleDateString([],{day:"numeric",month:"long"})}</span><span className="h-px flex-1 bg-border/60"/></div>
          {!detail?!error&&<div role="status" aria-label="Loading conversation" className="space-y-5">{[0,1,2].map(i=><div key={i} className={`flex items-end gap-2.5 ${i===1?"flex-row-reverse":""}`}><Skeleton className="size-8 shrink-0 rounded-xl"/><div className="w-3/4 space-y-2"><Skeleton className="h-3 w-24"/><Skeleton className="h-20 rounded-2xl"/></div></div>)}</div>:detail.messages.length===0?<div className="grid place-items-center gap-3 py-12 text-center text-muted-foreground"><MessageCircle className="size-8 opacity-40"/><p className="text-xs">{provider?"No messages yet.":"The visitor has opened a chat."}</p></div>:detail.messages.map(message=><ChatMessageBubble key={message.id} message={message} customerName={customerName} onAskCopilot={text=>setCopilotSeed({text,id:crypto.randomUUID()})} onReact={whatsapp&&canReply&&!locked?react:undefined}/>)}
          {detail?.customerTyping&&<div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="flex gap-1">{[0,1,2].map(i=><span key={i} className="size-1 rounded-full bg-teal-500 motion-safe:animate-pulse"/>)}</span>{customerName} is typing…</div>}<div ref={bottom}/>
        </div>
        {offered?<div className="shrink-0 border-t bg-teal-500/5 p-4 text-xs leading-relaxed text-muted-foreground">Accept this {provider?`${channelLabel} conversation`:"chat"} to reply. You can review the conversation and prepare a response with AI Copilot.</div>
          :wrapup?<div className="shrink-0 space-y-1 border-t bg-amber-500/5 p-4"><p className="text-xs font-semibold">{provider?"Conversation completed":"Chat ended"} · Wrap-up in progress</p>
            <p className="text-xs leading-relaxed text-muted-foreground">Complete the Wrapup Codes sheet to release this {provider?channelLabel:"chat"} slot.</p></div>
          :optedOut?<div className="shrink-0 border-t bg-red-500/5 p-4 text-xs leading-relaxed text-muted-foreground" role="status" data-testid="sms-blocked">The customer opted out with STOP. Replies stay blocked until they text START. You can still complete the conversation.</div>
          :sendingPaused?<div className="shrink-0 border-t bg-amber-500/5 p-4 text-xs leading-relaxed text-muted-foreground" role="status" data-testid={`${channel}-blocked`}>Sending is paused for this number. An administrator can allow agent replies in Admin → {channelLabel}.</div>
          :windowClosed?<div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t bg-amber-500/5 p-4 text-xs leading-relaxed text-muted-foreground" role="status" data-testid="whatsapp-blocked"><span>The 24-hour customer service window is closed. WhatsApp only allows an approved template until the customer writes again.</span><Button type="button" size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={locked||!canTemplate} onClick={()=>setTemplateOpen(true)}><LayoutTemplate className="mr-1 size-3.5"/>Send template</Button></div>
          :<form className="m-4 shrink-0 space-y-2" onSubmit={event=>{event.preventDefault();void send();}}>
            {compose.pending&&!busy&&<p role="status" className="text-xs text-amber-600 dark:text-amber-400">The send could not be confirmed. Confirm the previous send before changing this reply.</p>}
            {undoDraft!==null&&<div className="flex items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground"><span>Suggested reply inserted. Review before sending.</span><button type="button" disabled={locked} className="flex items-center gap-1 text-violet-600 disabled:opacity-50" onClick={()=>{edit(undoDraft);setUndoDraft(null);}}><Undo2 className="size-3"/>Undo</button></div>}
            <div className="space-y-2 rounded-xl border border-input bg-muted/20 p-3 shadow-sm transition focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-500/10" data-testid="chat-composer-frame">
              <div className="flex items-center gap-2"><ChatAvatar name={agentName} image={detail?.agent?.profile_picture_uri} className="size-5 rounded-md"/><span className="text-[10px] font-medium text-muted-foreground">Reply as {agentName}</span></div>
              <Textarea ref={composer} aria-label={`${provider?channelLabel:"Chat"} reply`} placeholder={provider?`Write your ${channelLabel} reply…`:"Write your reply…"} value={draft} maxLength={maxLength} onChange={event=>{edit(event.target.value);setUndoDraft(null);}} disabled={locked||!detail}
                className="min-h-20 max-h-40 resize-none rounded-lg border bg-background px-3 py-2 text-[13px] shadow-none focus-visible:ring-0 dark:bg-background dark:hover:bg-background"
                onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void send();}}}/>
              {segments&&<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] tabular-nums text-muted-foreground" data-testid="sms-segment-counter" aria-live="polite">
                <span>Encoding <Badge variant={segments.encoding==="UCS-2"?"destructive":"secondary"} className="ml-1 px-1.5 py-0 text-[10px]" data-testid="sms-encoding">{segments.encoding}</Badge></span>
                <span>Characters <strong className="font-semibold text-foreground">{segments.chars}</strong></span>
                <span>Parts <strong className={`font-semibold ${tooLong?"text-destructive":"text-foreground"}`} data-testid="sms-parts">{segments.parts}</strong></span>
                <span>Per part <strong className="font-semibold text-foreground">{segments.perPart}</strong></span>
                <span>Remaining <Badge variant={segments.remaining<=10?"destructive":"secondary"} className="ml-1 px-1.5 py-0 text-[10px]" data-testid="sms-remaining">{segments.remaining}</Badge></span>
                {tooLong&&<span className="text-destructive" role="alert">Shorten the message to at most 10 parts.</span>}
              </div>}
              {whatsapp&&<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] tabular-nums text-muted-foreground" data-testid="whatsapp-counter" aria-live="polite">
                <span>Bytes <strong className={`font-semibold ${tooLong?"text-destructive":"text-foreground"}`} data-testid="whatsapp-bytes">{textBytes}</strong> / {WHATSAPP_MAX_TEXT_BYTES}</span>
                {compose.files.length>0&&<span>{compose.files.length} file{compose.files.length===1?"":"s"} · caption goes with the first one</span>}
                {tooLong&&<span className="text-destructive" role="alert">WhatsApp text is limited to {WHATSAPP_MAX_TEXT_BYTES} bytes.</span>}
              </div>}
              {compose.files.length>0&&<ul aria-label="Attachments to send" className="flex flex-wrap gap-2">{compose.files.map(({id,file,kind})=><li key={id} className="max-w-full"><Badge variant="secondary" className="max-w-full gap-1.5 py-1.5 pl-2 pr-1">
                {busy?<Loader2 className="animate-spin"/>:kind==="sticker"?<Sticker/>:kind==="image"?<ImageIcon/>:<FileText/>}<span className="max-w-40 truncate" title={file.name}>{file.name}</span><span className="text-[10px] font-normal text-muted-foreground">{fileSize(file.size)}</span>
                {whatsapp&&file.type.startsWith("image/")&&<select aria-label={`Send ${file.name} as`} className="h-5 rounded border bg-background px-1 text-[10px]" value={kind||"image"} disabled={locked} onChange={event=>setKind(id,event.target.value)} data-testid="whatsapp-media-kind"><option value="image">Image</option><option value="sticker">Sticker</option><option value="document">Document</option></select>}
                <button type="button" className="rounded p-0.5 hover:bg-muted disabled:opacity-50" aria-label={`Remove attachment ${file.name}`} disabled={locked} onClick={()=>store.update(interaction.id,{files:compose.files.filter(item=>item.id!==id),error:""})}><X className="size-3"/></button>
              </Badge></li>)}</ul>}
              <div className="flex items-center justify-between"><div className="flex items-center gap-0.5">
                <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                  <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label="Emoji" disabled={locked||!canReply}><Smile className="size-4"/></Button></PopoverTrigger>
                  <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} className="w-auto max-w-[calc(100vw-1.5rem)] p-2" aria-label="Choose emoji"
                    onCloseAutoFocus={event=>{if(emojiInserted.current){event.preventDefault();emojiInserted.current=false;composer.current?.focus();}}}>
                    <EmojiPickerPanel onEmojiSelect={insertEmoji}/>
                  </PopoverContent>
                </Popover>
                {attachmentsEnabled&&<><input ref={fileInput} type="file" multiple className="hidden" accept={accept} onChange={event=>selectFiles(event.target.files)}/>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label={whatsapp?"Attach media":"Attach a file"} title={whatsapp?"Image, video, audio, document or sticker":"Attach a file"} disabled={locked||!canReply} onClick={()=>fileInput.current?.click()}><Paperclip className="size-4"/></Button></>}
                {whatsapp&&<><Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label="Search Pexels photos" title="Search Pexels photos" disabled={locked||!canReply} onClick={()=>setPexelsOpen(true)}><ImageIcon className="size-4"/></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label="Send a location" title="Send a location" disabled={locked||!canReply} onClick={()=>setLocationOpen(true)}><MapPin className="size-4"/></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label="Send a contact card" title="Send a contact card" disabled={locked||!canReply} onClick={()=>setContactOpen(true)}><Contact className="size-4"/></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 rounded-lg text-muted-foreground" aria-label="Send an approved template" title="Send an approved template" disabled={locked||!canTemplate} onClick={()=>setTemplateOpen(true)}><LayoutTemplate className="size-4"/></Button></>}
              </div><Button type="submit" size="sm" className={`h-8 rounded-lg text-xs text-white ${tone.send}`} disabled={busy||tooLong||(!compose.pending&&((!draft.trim()&&!compose.files.length)||!detail||Boolean(draftConflict)))}>{busy?<Loader2 className="size-3.5 animate-spin"/>:<Send className="size-3.5"/>}{compose.pending&&!busy?"Confirm previous send":busy?"Sending…":"Send"}</Button></div>
            </div><p className="px-1 text-[9px] text-muted-foreground">Ctrl / ⌘ + Enter to send · Replies are saved as drafts{sms&&" · Delivered means the carrier confirmed the handset, not that the customer read it"}{whatsapp&&" · Read means the customer opened the message"}</p>
          </form>}
      </section>
      <aside className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm @[700px]:min-h-0" aria-label="AI assistance and interaction details">
        <ChatContextPanel workItemId={interaction.id} channel={channel} seed={copilotSeed} onInsert={insertSuggestion} canInsert={canReply&&!locked&&!draftConflict} handoff={detail?.work.attributes?.handoff}/>
      </aside>
    </div>
    {whatsapp&&<PexelsPickerDialog open={pexelsOpen} onOpenChange={setPexelsOpen} onPick={file=>selectFiles([file])}/>}
    {whatsapp&&<WhatsAppTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} endpoint={endpoint} busy={busy} onSend={template=>void sendTemplate(template)}/>}
    {whatsapp&&<WhatsAppLocationDialog open={locationOpen} onOpenChange={setLocationOpen} busy={busy} onSend={location=>void sendLocation(location)}/>}
    {whatsapp&&<WhatsAppContactDialog open={contactOpen} onOpenChange={setContactOpen} busy={busy} onSend={contactIds=>void sendContacts(contactIds)}/>}
  </div>;
}
