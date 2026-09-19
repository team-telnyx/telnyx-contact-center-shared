"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { CheckCircle2,CircleOff,Plus,RefreshCw,Save,Smartphone,Trash2,Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from '@/components/ui/dialog';
import { notify } from '@/components/ToastNotify';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { api,Field,Loading,StatusBadge } from './whatsapp-admin-shared';
import { WHATSAPP_PROFILE_CATEGORIES,WHATSAPP_VERIFICATION_LANGUAGES } from '@/lib/whatsapp/admin-model.mjs';

// Meta serves the business profile photo from its CDN; next/image cannot optimize it.
function ProfilePhoto({url}){
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Profile" className="size-full object-cover"/>;
}
const profileForm=(profile={})=>({displayName:profile.display_name||'',category:profile.category||'',about:profile.about||'',description:profile.description||'',email:profile.email||'',website:profile.website||'',address:profile.address||'',profileId:profile.profile_id||''});

function PhoneNumberEditor({number,profiles,busy,setBusy,onChanged}){
  const [detail,setDetail]=useState(null),[loading,setLoading]=useState(true),[form,setForm]=useState(profileForm()),[code,setCode]=useState(''),[method,setMethod]=useState('sms'),[error,setError]=useState('');
  const fileInput=useRef(null);
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{const data=await api({resource:'phone-number',phone:number.phoneNumber});setDetail(data);setForm(profileForm(data.profile));}
    catch(e){setError(e.message);}finally{setLoading(false);}
  },[number.phoneNumber]);
  useEffect(()=>{void load();},[load]);
  async function run(body,title){
    setBusy(true);setError('');
    try{const result=await api({},body);notify({title,variant:'success'});await load();onChanged?.();return result;}
    catch(e){setError(e.message);notify({title:'Phone number action failed',description:e.message,variant:'error'});return null;}finally{setBusy(false);}
  }
  async function photo(file){
    if(!file)return;setBusy(true);
    try{const body=new FormData();body.set('phoneNumber',number.phoneNumber);body.set('file',file);const response=await fetch('/api/admin/whatsapp/photo',{method:'POST',body});const result=await response.json();if(!response.ok)throw Error(result.error);notify({title:'Profile photo updated',variant:'success'});await load();}
    catch(e){notify({title:'Photo upload failed',description:e.message,variant:'error'});}finally{setBusy(false);if(fileInput.current)fileInput.current.value='';}
  }
  async function removePhoto(){
    setBusy(true);try{const response=await fetch(`/api/admin/whatsapp/photo?phone=${encodeURIComponent(number.phoneNumber)}`,{method:'DELETE'});const result=await response.json();if(!response.ok)throw Error(result.error);notify({title:'Profile photo removed',variant:'success'});await load();}
    catch(e){notify({title:'Photo removal failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  const connected=String(number.status||'').toUpperCase()==='CONNECTED';
  const photoUrl=detail?.photo?.profile_photo_url||detail?.profile?.profile_photo_url||'';
  return <div className="space-y-4" data-testid="whatsapp-phone-editor">
    {error&&<p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
    {loading&&!detail?<Card><CardContent className="p-6"><Loading label="Loading phone number"/></CardContent></Card>:<>
    <Card><CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex items-start gap-4"><div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted">{photoUrl?<ProfilePhoto url={photoUrl}/>:<Smartphone className="size-6 text-muted-foreground"/>}</div>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">{number.displayName}</p><StatusBadge value={number.status}/><StatusBadge value={number.qualityRating}/></div><p className="mt-1 font-mono text-xs text-muted-foreground">{number.phoneNumber}{number.phoneNumberId?` · ${number.phoneNumberId}`:''}</p>
          <div className="mt-3 flex flex-wrap gap-2"><input ref={fileInput} type="file" accept="image/jpeg,image/png" className="hidden" onChange={e=>void photo(e.target.files?.[0])}/><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>fileInput.current?.click()}><Upload className="mr-1 size-3.5"/>Upload photo</Button>{photoUrl&&<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>void removePhoto()}>Remove photo</Button>}</div></div></div>
      <div className="space-y-3 rounded-xl border p-3"><label className="flex items-center justify-between gap-3 text-xs"><span><span className="font-medium">WhatsApp calling</span><span className="block text-[10px] text-muted-foreground">Allow customers to call this number on WhatsApp.</span></span><Switch checked={Boolean(detail?.calling?.enabled)} disabled={busy||Boolean(detail?.calling?.error)} onCheckedChange={v=>void run({action:'set_calling',phoneNumber:number.phoneNumber,enabled:v},v?'WhatsApp calling enabled':'WhatsApp calling disabled')}/></label>
        {detail?.calling?.error&&<p className="text-[10px] text-amber-700 dark:text-amber-300">{detail.calling.error}</p>}
        <div className="text-[10px] text-muted-foreground">{detail?.managed?<>Mapped to a Contact Center queue as <span className="font-medium">{detail.managed.name}</span>.</>:'Not mapped to a Contact Center queue. Use Numbers to route inbound messages.'}</div></div>
    </CardContent></Card>
    {!connected&&<Card><CardHeader><CardTitle>Verify number</CardTitle><p className="text-xs text-muted-foreground">Enter the code Meta sent to this number, or request a new one.</p></CardHeader><CardContent className="grid gap-3 sm:grid-cols-[1fr_160px_auto_auto]">
      <Field label="Verification code"><Input value={code} onChange={e=>setCode(e.target.value)} placeholder="123456"/></Field>
      <Field label="Method"><Select value={method} onValueChange={setMethod}><SelectTrigger className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="sms">SMS</SelectItem><SelectItem value="voice">Voice call</SelectItem></SelectContent></Select></Field>
      <Button className="self-end" size="sm" variant="outline" disabled={busy} onClick={()=>void run({action:'resend_verification',phoneNumber:number.phoneNumber,verificationMethod:method},'Verification code requested')}>Resend</Button>
      <Button className="self-end" size="sm" disabled={busy||!code.trim()} onClick={()=>void run({action:'verify_number',phoneNumber:number.phoneNumber,code},'Number verified')}>Verify</Button>
    </CardContent></Card>}
    <Card><CardHeader><CardTitle>Business profile</CardTitle><p className="text-xs text-muted-foreground">Shown to customers in WhatsApp. The messaging profile decides where inbound messages go.</p></CardHeader><CardContent className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name"><Input value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/></Field>
        <Field label="Category"><Select value={form.category||undefined} onValueChange={value=>setForm({...form,category:value})}><SelectTrigger className="w-full" data-testid="whatsapp-profile-category"><SelectValue placeholder="Select category"/></SelectTrigger><SelectContent className="max-h-80">{WHATSAPP_PROFILE_CATEGORIES.map(c=><SelectItem key={c} value={c}>{c.replace(/_/g,' ')}</SelectItem>)}</SelectContent></Select></Field>
        <Field label={`About (${form.about.length}/139)`}><Input value={form.about} maxLength={139} onChange={e=>setForm({...form,about:e.target.value})}/></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
        <Field label="Website"><Input value={form.website} onChange={e=>setForm({...form,website:e.target.value})} placeholder="https://"/></Field>
        <Field label="Messaging profile (inbound messages)" hint="Contact Center profiles route inbound messages here; any other profile ID keeps the number elsewhere.">
          <Input list="whatsapp-profile-ids" value={form.profileId} onChange={e=>setForm({...form,profileId:e.target.value})} placeholder="Messaging profile ID"/><datalist id="whatsapp-profile-ids">{profiles.map(p=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}</datalist></Field>
      </div>
      <Field label={`Description (${form.description.length}/512)`}><Textarea rows={3} maxLength={512} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field>
      <Field label="Address"><Input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></Field>
      <Button size="sm" disabled={busy} onClick={()=>void run({action:'save_phone_profile',phoneNumber:number.phoneNumber,profile:form},'Business profile saved')}><Save className="mr-1 size-3.5"/>Save profile</Button>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Remove number</CardTitle><p className="text-xs text-muted-foreground">Deregisters the number from the WhatsApp Business Account in Telnyx. Remove its queue mapping first.</p></CardHeader><CardContent><Button size="sm" variant="ghost" className="text-destructive" disabled={busy||Boolean(detail?.managed)} onClick={()=>{if(window.confirm(`Remove ${number.phoneNumber} from the WhatsApp Business Account?`))void run({action:'delete_phone_number',phoneNumber:number.phoneNumber},'Number removed');}}><Trash2 className="mr-1 size-3.5"/>Remove from WABA</Button></CardContent></Card>
    </>}
  </div>;
}

export default function WhatsAppPhoneNumbersSection({account,phoneNumbers,profiles,loading,busy,setBusy,onChanged}){
  const [selected,setSelected]=useState(''),[addOpen,setAddOpen]=useState(false),[form,setForm]=useState({phoneNumber:'',displayName:'',verificationMethod:'sms',language:'en_US'});
  const current=phoneNumbers.find(n=>n.phoneNumber===selected)||null;
  async function add(event){
    event.preventDefault();setBusy(true);
    try{await api({},{action:'add_phone_number',accountId:account?.id,...form});notify({title:'Verification requested',description:'Enter the code under the number once it arrives.',variant:'success'});setAddOpen(false);setForm({phoneNumber:'',displayName:'',verificationMethod:'sms',language:'en_US'});onChanged?.();}
    catch(e){notify({title:'Could not add the number',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  return <div className="space-y-4" data-testid="whatsapp-phone-numbers">
    <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle className="flex items-center gap-2"><Smartphone className="size-4 text-green-600"/>Phone numbers</CardTitle><p className="mt-1 text-xs text-muted-foreground">Status, quality rating, business profile and WhatsApp calling for every number on the account.</p></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy||loading} onClick={()=>onChanged?.()}><RefreshCw className={`mr-1 size-3.5 ${loading?'animate-spin':''}`}/>Refresh</Button><Button size="sm" disabled={busy||!account?.id} onClick={()=>setAddOpen(true)}><Plus className="mr-1 size-3.5"/>Add number</Button></div></CardHeader>
      <CardContent>{loading?<Loading label="Loading phone numbers"/>:phoneNumbers.length?<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{phoneNumbers.map(number=><button key={number.phoneNumber} type="button" data-testid="whatsapp-phone-card" onClick={()=>setSelected(number.phoneNumber)} className={`rounded-xl border p-4 text-left transition-colors ${selected===number.phoneNumber?'border-green-600 bg-green-600/10':'hover:bg-muted/40'}`}>
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{number.displayName}</p><p className="font-mono text-xs text-muted-foreground">{number.phoneNumber}</p></div>{number.enabled?<CheckCircle2 className="size-5 shrink-0 text-emerald-500"/>:<CircleOff className="size-5 shrink-0 text-amber-500"/>}</div>
        <div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={number.status}/><StatusBadge value={number.qualityRating}/>{number.managed&&<span className="rounded-full bg-green-600/10 px-2 py-1 text-[10px] font-medium text-green-700 dark:text-green-300">Queue: {number.managed.name}</span>}</div>
      </button>)}</div>:<div className="rounded-xl border border-dashed p-8 text-center"><Smartphone className="mx-auto mb-3 size-8 text-green-600"/><p className="text-sm font-medium">No phone numbers registered</p><p className="mt-1 text-xs text-muted-foreground">Add a number to start the WhatsApp verification with Meta.</p></div>}</CardContent></Card>
    {current&&<PhoneNumberEditor key={current.phoneNumber} number={current} profiles={profiles} busy={busy} setBusy={setBusy} onChanged={onChanged}/>}
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>Add a WhatsApp number</DialogTitle><DialogDescription>Meta sends a verification code by SMS or voice call to the number.</DialogDescription></DialogHeader>
      <form className="space-y-3" onSubmit={add}>
        <Field label="Phone number (E.164)"><Input required value={form.phoneNumber} onChange={e=>setForm({...form,phoneNumber:e.target.value})} placeholder="+15551234567"/></Field>
        <Field label="Display name"><Input required value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Verification"><Select value={form.verificationMethod} onValueChange={value=>setForm({...form,verificationMethod:value})}><SelectTrigger className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="sms">SMS</SelectItem><SelectItem value="voice">Voice call</SelectItem></SelectContent></Select></Field>
          <Field label="Language"><Select value={form.language} onValueChange={value=>setForm({...form,language:value})}><SelectTrigger className="w-full"><SelectValue/></SelectTrigger><SelectContent>{WHATSAPP_VERIFICATION_LANGUAGES.map(l=><SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent></Select></Field></div>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={()=>setAddOpen(false)}>Cancel</Button><Button size="sm" disabled={busy}>Request verification</Button></div>
      </form></DialogContent></Dialog>
  </div>;
}
