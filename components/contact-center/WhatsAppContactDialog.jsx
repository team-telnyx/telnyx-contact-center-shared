"use client";
import { useEffect,useRef,useState } from "react";
import { Contact,Loader2,Search,Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { WHATSAPP_MAX_CONTACTS } from "@/lib/whatsapp/policy.mjs";

const contactName=contact=>contact.display_name||[contact.first_name,contact.last_name].filter(Boolean).join(" ")||contact.company_name||"Unnamed contact";
const contactPhone=contact=>contact.mobile||contact.phone||contact.business_phone_1||contact.home_phone_1||"";
// Contact cards come from the Contacts directory; the server builds the
// WhatsApp contact payload from the selected ids.
export default function WhatsAppContactDialog({open,onOpenChange,onSend,busy}){
  const [query,setQuery]=useState(""),[contacts,setContacts]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[selected,setSelected]=useState([]);
  const timer=useRef(null),latest=useRef(0);
  useEffect(()=>{if(open){setQuery("");setSelected([]);setError("");}},[open]);
  useEffect(()=>{
    if(!open)return;
    clearTimeout(timer.current);
    timer.current=setTimeout(async()=>{
      const ticket=++latest.current;setLoading(true);
      try{const params=new URLSearchParams({pageSize:"50"});if(query.trim())params.set("q",query.trim());
        const response=await fetch(`/api/contacts?${params}`,{cache:"no-store"});const data=await response.json();
        if(ticket!==latest.current)return;if(!response.ok)throw Error(data.error||"Contacts are unavailable");setContacts(data.rows||[]);setError("");}
      catch(reason){if(ticket===latest.current){setContacts([]);setError(reason.message);}}
      finally{if(ticket===latest.current)setLoading(false);}
    },query?350:0);
    return()=>clearTimeout(timer.current);
  },[query,open]);
  function toggle(id){setSelected(current=>current.includes(id)?current.filter(item=>item!==id):current.length>=WHATSAPP_MAX_CONTACTS?current:[...current,id]);}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-xl" data-testid="whatsapp-contact-dialog">
    <DialogHeader><DialogTitle>Send a contact card</DialogTitle><DialogDescription>Pick up to {WHATSAPP_MAX_CONTACTS} contacts from the directory. The customer receives name, phone numbers, email and company as a WhatsApp contact card.</DialogDescription></DialogHeader>
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
      <Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search by name or company" aria-label="Contact search" className="pl-8" autoComplete="off"/>
      {loading&&<Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true"/>}
    </div>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
    <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border" aria-label="Contacts" data-testid="whatsapp-contact-list">
      {contacts===null?<li className="p-3 text-xs text-muted-foreground">Loading contacts…</li>:!contacts.length?<li className="p-3 text-xs text-muted-foreground">No contacts match your search.</li>:contacts.map(contact=>{
        const checked=selected.includes(contact.id);
        return <li key={contact.id}><label className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-xs hover:bg-accent ${checked?"bg-accent/60":""}`}>
          <Checkbox checked={checked} onCheckedChange={()=>toggle(contact.id)} aria-label={`Select ${contactName(contact)}`} data-testid="whatsapp-contact-option" data-contact-id={contact.id}/>
          <Contact className="size-4 shrink-0 text-muted-foreground" aria-hidden="true"/>
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{contactName(contact)}</span><span className="block truncate text-muted-foreground">{[contact.company_name,contactPhone(contact),contact.email_address_1].filter(Boolean).join(" · ")||"No phone or email on file"}</span></span>
        </label></li>;})}
    </ul>
    <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-muted-foreground">{selected.length} of {WHATSAPP_MAX_CONTACTS} selected</span><span className="flex gap-2"><Button type="button" variant="ghost" size="sm" onClick={()=>onOpenChange(false)}>Cancel</Button>
      <Button type="button" size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={busy||!selected.length} data-testid="whatsapp-contact-send" onClick={()=>onSend(selected)}>{busy?<Loader2 className="mr-1 size-3.5 animate-spin"/>:<Send className="mr-1 size-3.5"/>}Send {selected.length>1?`${selected.length} contacts`:"contact"}</Button></span></div>
  </DialogContent></Dialog>;
}
