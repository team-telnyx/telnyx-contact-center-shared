"use client";

import { useState } from "react";
import { AlertCircle,Bot,Brain,Check,CheckCheck,Clock,Contact,Copy,HelpCircle,LayoutTemplate,MapPin,Maximize2,SmilePlus,UserRound,X } from "lucide-react";
import { smsMessageStatus } from "@/lib/sms/message-status.mjs";
import { whatsappMessageStatus } from "@/lib/whatsapp/message-status.mjs";
import { WHATSAPP_QUICK_REACTIONS } from "@/lib/whatsapp/policy.mjs";
import { parseLatitude,parseLongitude } from "@/lib/contact-center/maps.mjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Avatar,AvatarFallback,AvatarImage } from "@/components/ui/avatar";
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover";
import ChatAttachments from "./ChatAttachments";
import LocationMapPreview from "./LocationMapPreview";
import LocationPreviewDialog from "./LocationPreviewDialog";

function avatarUrl(value){return typeof value==="string"&&(/^(https?:\/\/|\/api\/)/.test(value)||/^data:image\/(png|jpeg|webp|gif);base64,/.test(value))?value:undefined;}
export function ChatAvatar({name,image,bot=false,className=""}){
  const initials=String(name||"").trim().split(/\s+/).slice(0,2).map(n=>n[0]).join("").toUpperCase();
  return <Avatar className={`size-8 shrink-0 rounded-xl ${className}`}><AvatarImage src={avatarUrl(image)} alt={name}/><AvatarFallback className={`rounded-xl text-[10px] font-semibold ${bot?"bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300":"bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200"}`}>
    {bot?<Bot className="size-4"/>:initials||<UserRound className="size-4"/>}</AvatarFallback></Avatar>;
}
export function CopyChatText({text,label="Copy message",className=""}){
  const [copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
  return <button type="button" className={`grid size-6 place-items-center rounded-md opacity-65 transition hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10 ${className}`} aria-label={copied?"Copied":failed?"Copy failed; select text to copy":label} title={copied?"Copied":failed?"Copy failed; select text to copy":label}
    onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);setFailed(false);setTimeout(()=>setCopied(false),1800);}catch{setFailed(true);}}}>
    {copied?<Check className="size-3.5"/>:<Copy className="size-3.5"/>}</button>;
}
// Provider delivery evidence (SMS, WhatsApp) replaces the static sent tick.
// Delivered means the handset confirmed receipt; only WhatsApp reports "Read".
export function DeliveryIndicator({message}){
  const whatsapp=message.delivery?.provider==="whatsapp";
  const {status,label,tone,title}=(whatsapp?whatsappMessageStatus:smsMessageStatus)(message);
  const Icon=["delivered","read"].includes(status)?CheckCheck:["sent","accepted"].includes(status)?Check:tone==="danger"?AlertCircle:tone==="warning"?HelpCircle:Clock;
  const color=tone==="read"?"text-sky-500":tone==="success"?"text-teal-600":tone==="danger"?"text-red-600":tone==="warning"?"text-amber-600":"text-muted-foreground";
  return <span className={`inline-flex items-center gap-0.5 ${color}`} data-testid="message-delivery" data-delivery-status={status} title={title}><Icon className="size-3"/><span className="sr-only">{label}</span></span>;
}
// Structured WhatsApp content that has no file: shared locations, contact
// cards, interactive replies, reactions and the template a reply used.
function validLocation(location){try{return Boolean(location)&&Number.isFinite(parseLatitude(location.latitude))&&Number.isFinite(parseLongitude(location.longitude));}catch{return false;}}
export function WhatsAppContent({content,orphanReaction=false}){
  const [preview,setPreview]=useState(false);
  if(!content)return null;
  const {location,contacts,interactive_reply:reply,reaction,template}=content;
  const mappable=validLocation(location);
  return <div className="mt-2 space-y-2 text-[12px]" data-testid="whatsapp-content">
    {location&&<button type="button" className="group/location block w-full overflow-hidden rounded-lg border border-black/10 bg-black/5 text-left dark:border-white/10 dark:bg-white/10" onClick={()=>mappable&&setPreview(true)} aria-label={`Preview location ${location.name||`${location.latitude}, ${location.longitude}`}`} data-testid="whatsapp-location">
      {mappable&&<span className="relative block"><LocationMapPreview latitude={location.latitude} longitude={location.longitude} width={280} height={150} className="rounded-none border-0" label={location.name||"Shared location"}/>
        <span className="absolute right-2 top-2 rounded-lg bg-black/45 p-1.5 text-white opacity-80 group-hover/location:opacity-100"><Maximize2 className="size-3.5"/></span></span>}
      <span className="flex items-start gap-2 p-2"><MapPin className="mt-0.5 size-4 shrink-0"/><span><span className="block font-medium">{location.name||"Shared location"}</span><span className="block opacity-80">{location.address||`${location.latitude}, ${location.longitude}`}</span></span></span></button>}
    {mappable&&<LocationPreviewDialog location={location} open={preview} onOpenChange={setPreview}/>}
    {contacts?.length>0&&contacts.map((contact,index)=><div key={index} className="flex items-start gap-2 rounded-lg border border-black/10 bg-black/5 p-2 dark:border-white/10 dark:bg-white/10" data-testid="whatsapp-contact-card"><Contact className="mt-0.5 size-4 shrink-0"/><span><span className="block font-medium">{contact.name||"Contact"}</span>{contact.company&&<span className="block opacity-80">{contact.company}</span>}{contact.phones?.map(phone=><span key={phone} className="block opacity-80">{phone}</span>)}{contact.emails?.map(email=><span key={email} className="block opacity-80">{email}</span>)}</span></div>)}
    {reply&&<span className="inline-flex items-center rounded-full border border-black/10 bg-black/5 px-2 py-0.5 text-[11px] dark:border-white/10 dark:bg-white/10">Selected: {reply.title||reply.id}</span>}
    {reaction?.emoji&&orphanReaction&&<span className="block text-[11px] opacity-70">Reaction to an earlier message</span>}
    {template&&<span className="inline-flex items-center gap-1 rounded-full border border-black/10 bg-black/5 px-2 py-0.5 text-[11px] dark:border-white/10 dark:bg-white/10"><LayoutTemplate className="size-3"/>Template {template.name||""}{template.language?` · ${template.language}`:""}</span>}
  </div>;
}
// Agent reaction to a customer WhatsApp message: quick emojis, or remove the
// current one. The composer sends it like any other message.
function ReactionPicker({message,onReact,mine}){
  const [open,setOpen]=useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className="grid size-6 place-items-center rounded-md opacity-65 transition hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10" title={mine?`You reacted ${mine}. Change or remove the reaction`:"React with an emoji"} aria-label={mine?`Change your ${mine} reaction`:"React to this message"} data-testid="message-react"><SmilePlus className="size-3.5"/></button></PopoverTrigger>
    <PopoverContent side="top" align="start" sideOffset={4} className="w-auto p-1.5" aria-label="Quick reactions">
      <div className="flex items-center gap-0.5" role="group">
        {WHATSAPP_QUICK_REACTIONS.map(emoji=><button key={emoji} type="button" className={`grid size-8 place-items-center rounded-md text-lg transition hover:bg-accent ${mine===emoji?"bg-accent ring-1 ring-green-600":""}`} aria-label={mine===emoji?`Remove ${emoji} reaction`:`React ${emoji}`} aria-pressed={mine===emoji} data-testid="message-react-option" data-emoji={emoji} onClick={()=>{setOpen(false);onReact(message,mine===emoji?"":emoji);}}>{emoji}</button>)}
        {mine&&!WHATSAPP_QUICK_REACTIONS.includes(mine)&&<button type="button" className="grid size-8 place-items-center rounded-md bg-accent text-lg ring-1 ring-green-600" aria-label={`Remove ${mine} reaction`} onClick={()=>{setOpen(false);onReact(message,"");}}>{mine}</button>}
        {mine&&<button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label="Remove reaction" data-testid="message-react-remove" onClick={()=>{setOpen(false);onReact(message,"");}}><X className="size-4"/></button>}
      </div>
    </PopoverContent>
  </Popover>;
}
export default function ChatMessageBubble({message,customerName,onAskCopilot,onReact,showSentIndicator=true}){
  const agent=message.sender_role==="agent",bot=message.sender_role==="system"&&message.sender_id==="widget-ai";
  const name=agent?[message.first_name,message.last_name].filter(Boolean).join(" ")||"Agent":bot?"AI assistant":message.sender_role==="system"?"System":customerName;
  const hasFiles=Boolean(message.attachments?.length);
  const onlyFileName=hasFiles&&(!message.body?.trim()||message.attachments.some(f=>f.name===message.body?.trim()));
  const whatsapp=message.delivery?.provider==="whatsapp";
  const whatsappContent=whatsapp?message.delivery.content:null;
  const reactions=whatsapp?message.delivery.reactions||[]:[];
  const quoted=whatsapp?message.delivery.quoted:null;
  const mine=reactions.find(entry=>entry.sender_role==="agent")?.emoji||"";
  const canReact=Boolean(onReact)&&!agent&&whatsapp&&Boolean(message.delivery.provider_message_id);
  return <div className={`flex items-end gap-2.5 ${agent?"flex-row-reverse":""}`} data-testid="chat-message" data-role={message.sender_role}>
    <ChatAvatar name={name} image={message.profile_picture_uri} bot={bot}/>
    <div className={`flex min-w-0 flex-col ${onlyFileName?"max-w-[min(calc(100%-3rem),22rem)]":"max-w-[calc(100%-3rem)]"} ${agent?"items-end":"items-start"}`}>
      <div className={`mb-1.5 flex max-w-full items-center gap-2 px-1 ${agent?"justify-end":""}`}><span className="truncate text-[11px] font-semibold text-muted-foreground">{name}</span>
        {bot&&<span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-medium text-violet-600 dark:text-violet-300">AI</span>}</div>
      <article className={`w-fit min-w-0 max-w-full rounded-2xl border p-3 shadow-sm ${agent?"rounded-br-md border-emerald-400 bg-telnyx-green text-slate-950 dark:border-slate-200 dark:bg-slate-100":bot?"rounded-bl-md border-violet-600 bg-violet-600 text-white":"rounded-bl-md border-slate-200 bg-white text-slate-950 dark:border-emerald-400 dark:bg-telnyx-green"}`}>
        {quoted&&<div className="mb-2 rounded-md border-l-2 border-current/40 bg-black/5 px-2 py-1 text-[11px] opacity-80 dark:bg-white/10" data-testid="message-quote"><span className="block font-semibold">{quoted.sender_role==="agent"?"You":customerName}</span><span className="block truncate">{quoted.body}</span></div>}
        {!onlyFileName&&<div className={`max-w-none [overflow-wrap:anywhere] text-[13px] leading-relaxed [&_p]:my-1 [&_a]:font-medium [&_a]:underline [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ${bot?"[&_a]:text-white":"[&_a]:text-violet-900"}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown></div>}
        {hasFiles&&<div className={onlyFileName?"":"mt-2"}><ChatAttachments files={message.attachments}/></div>}
        {whatsappContent&&<WhatsAppContent content={whatsappContent} orphanReaction={Boolean(message.delivery.orphan_reaction)}/>}
      </article>
      {reactions.length>0&&<div className={`-mt-2 flex flex-wrap gap-1 px-2 ${agent?"justify-end":""}`} data-testid="message-reactions">{reactions.map(entry=><span key={`${entry.sender_role}:${entry.sender_id}`} className={`inline-flex items-center gap-0.5 rounded-full border bg-background px-1.5 py-0.5 text-[12px] leading-none shadow-sm ${entry.status==="failed"||entry.status==="ambiguous"?"border-red-500":"border-black/10 dark:border-white/10"}`} data-sender={entry.sender_role} data-emoji={entry.emoji} title={`${entry.sender_role==="agent"?"You":customerName} reacted ${entry.emoji}${entry.status==="failed"?" (not delivered)":""}`}>{entry.emoji}{(entry.status==="failed"||entry.status==="ambiguous")&&<AlertCircle className="size-3 text-red-600"/>}</span>)}</div>}
      <div className="mt-1.5 flex self-stretch items-center justify-between gap-2 px-1 text-[10px] tabular-nums text-muted-foreground" data-testid="chat-message-footer"><span className="flex items-center gap-1"><time dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>{new Date(message.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time>{agent&&message.delivery?<DeliveryIndicator message={message}/>:agent&&showSentIndicator&&<Check className="size-3 text-teal-600"/>}</span><div className="flex items-center gap-0.5">
        {canReact&&<ReactionPicker message={message} onReact={onReact} mine={mine}/>}
        {onAskCopilot&&<button type="button" onClick={()=>onAskCopilot(message.body)} className="grid size-6 place-items-center rounded-md opacity-65 transition hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100 dark:hover:bg-white/10" title="Ask AI Copilot" aria-label={`Ask AI Copilot about ${name}'s message`}><Brain className="size-3.5"/></button>}<CopyChatText text={message.body}/>
      </div></div>
    </div>
  </div>;
}
