"use client";
import { useEffect,useState } from "react";
import { Loader2,Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import WhatsAppPhonePreview from "@/components/whatsapp/WhatsAppPhonePreview";
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select";

// Approved template picker used when the 24-hour customer service window is
// closed. Variables are filled by the agent; the server resolves the template.
export default function WhatsAppTemplateDialog({open,onOpenChange,endpoint,onSend,busy}){
  const [templates,setTemplates]=useState(null),[error,setError]=useState(""),[selectedId,setSelectedId]=useState(""),[values,setValues]=useState({});
  useEffect(()=>{
    if(!open)return;let cancelled=false;
    const load=async()=>{
      try{const response=await fetch(`${endpoint}/templates`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw Error(data.error||"Templates are unavailable");
        if(cancelled)return;const list=data.templates||[];const first=list[0]||null;
        setTemplates(list);setError("");setSelectedId(first?.id||"");setValues(Object.fromEntries((first?.fields||[]).map(field=>[field.key,field.defaultValue||""])));}
      catch(reason){if(!cancelled){setError(reason.message);setTemplates([]);}}
    };
    void load();
    return()=>{cancelled=true;};
  },[open,endpoint]);
  const template=templates?.find(t=>t.id===selectedId)||null;
  function choose(id){const next=templates?.find(t=>t.id===id)||null;setSelectedId(id);setValues(Object.fromEntries((next?.fields||[]).map(field=>[field.key,field.defaultValue||""])));}
  const complete=template&&(template.fields||[]).every(field=>String(values[field.key]||"").trim());
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-3xl" data-testid="whatsapp-template-dialog">
    <DialogHeader><DialogTitle>Send an approved template</DialogTitle><DialogDescription>Templates reopen a conversation whose 24-hour window has closed. Only templates approved by Meta are listed.</DialogDescription></DialogHeader>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
    {templates===null?<div className="space-y-2"><Skeleton className="h-9 w-full"/><Skeleton className="h-32 w-full"/></div>:!templates.length?<p className="text-sm text-muted-foreground">No approved templates are available for this number. Ask an administrator to create one under Admin → WhatsApp → Templates.</p>:
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-3">
        <div className="space-y-1.5 text-xs font-medium">Template<Select value={selectedId||undefined} onValueChange={choose}><SelectTrigger className="h-auto min-h-10 w-full py-1.5" data-testid="whatsapp-template-choice"><SelectValue placeholder="Select a template"/></SelectTrigger><SelectContent className="max-h-80">{templates.map(t=><SelectItem key={t.id} value={t.id} textValue={`${t.name} ${t.language} ${t.category}`}><span className="flex min-w-0 flex-col"><span className="truncate font-medium">{t.name}</span><span className="truncate text-xs font-normal text-muted-foreground">{t.language} · {t.category}</span></span></SelectItem>)}</SelectContent></Select></div>
        {template?.fields?.length?<div className="space-y-2">{template.fields.map(field=><label key={field.key} className="block space-y-1.5 text-xs font-medium">{field.label}<Input value={values[field.key]||""} onChange={e=>setValues({...values,[field.key]:e.target.value})} placeholder={field.defaultValue||""}/></label>)}</div>:<p className="text-xs text-muted-foreground">This template has no variables.</p>}
      </div>
      <div className="mx-auto w-full max-w-[300px]">{template&&<WhatsAppPhonePreview contactName="Template preview" className="max-w-[300px] [&>div>div]:h-[520px]" messages={[{direction:"outbound",status:"read",kind:"template",template:{name:template.name,category:template.category,components:template.components||[]},values}]}/>}</div>
    </div>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={()=>onOpenChange(false)}>Cancel</Button><Button type="button" size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={busy||!template||!complete} onClick={()=>onSend({id:template.id,values})}>{busy?<Loader2 className="mr-1 size-3.5 animate-spin"/>:<Send className="mr-1 size-3.5"/>}Send template</Button></div>
  </DialogContent></Dialog>;
}
