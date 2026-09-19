"use client";
import { useState } from 'react';
import { Check,Copy } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { notify } from '@/components/ToastNotify';
import { whatsappMessageStatus } from '@/lib/whatsapp/message-status.mjs';
import { statusTone } from '@/lib/whatsapp/admin-model.mjs';

export const rowsOf=result=>Array.isArray(result?.data)?result.data:Array.isArray(result)?result:[];
export async function api(params={},body){
  const response=await fetch(`/api/admin/whatsapp${Object.keys(params).length?`?${new URLSearchParams(params)}`:''}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'WhatsApp administration unavailable');return result;
}
export const date=value=>value?new Date(value).toLocaleString():'—';
export const humanize=value=>String(value||'—').replace(/_/g,' ').toLowerCase().replace(/^\w/,c=>c.toUpperCase());
export function Field({label,children,hint}){return <label className="block space-y-1.5 text-xs font-medium">{label}{children}{hint&&<span className="block text-[10px] font-normal text-muted-foreground">{hint}</span>}</label>;}
export function Status({enabled,children}){return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${enabled?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted text-muted-foreground'}`}>{enabled&&<Check className="size-3"/>}{children}</span>;}
const TONES={neutral:'border-border bg-muted/50 text-muted-foreground',info:'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',success:'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  read:'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',warning:'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',danger:'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'};
export function StatusBadge({value,tone}){return <Badge variant="outline" className={TONES[tone||statusTone(value)]||TONES.neutral}>{humanize(value)}</Badge>;}
export function DeliveryBadge({row}){const {label,tone,title}=whatsappMessageStatus({sender_role:'agent',delivery:row});return <Badge variant="outline" title={title} className={TONES[tone]||TONES.neutral}>{label}</Badge>;}
export function Loading({label='Loading WhatsApp configuration',rows=3}){
  return <div role="status" aria-label={label} className="space-y-4"><span className="sr-only">{label}</span>{Array.from({length:rows},(_,i)=><div key={i} className="space-y-2"><Skeleton className="h-4 w-1/3"/><Skeleton className="h-9 w-full"/></div>)}</div>;
}
export function ResourceTable({rows,columns,action,loading=false,empty='No records to display.'}){
  if(loading)return <div className="rounded-xl border p-4"><Loading label="Loading records"/></div>;
  return <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-muted/50"><tr>{columns.map(([key,label])=><th key={key} className="whitespace-nowrap p-3 font-medium">{label}</th>)}{action&&<th className="p-3">Actions</th>}</tr></thead><tbody>{rows.map((row,i)=><tr key={row.id||row.message_id||row.event_id||row.conversation_id||row.phoneNumber||i} className="border-t">{columns.map(([key,,render])=><td key={key} className="max-w-80 break-words p-3">{render?render(row[key],row):typeof row[key]==='object'&&row[key]!==null?JSON.stringify(row[key]):String(row[key]??'—')}</td>)}{action&&<td className="p-3">{action(row)}</td>}</tr>)}{!rows.length&&<tr><td colSpan={columns.length+Number(Boolean(action))} className="p-6 text-center text-muted-foreground">{empty}</td></tr>}</tbody></table></div>;
}
export function CopyValue({label,value}){
  const [copied,setCopied]=useState(false);
  return <div className="space-y-1.5"><p className="text-xs text-muted-foreground">{label}</p><div className="flex min-h-9 items-center gap-2 rounded-md border bg-muted/20 px-3 text-xs"><span className="min-w-0 flex-1 truncate font-mono" title={value||''}>{value||'—'}</span>
    {value&&<button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Copy ${label}`} onClick={async()=>{try{await navigator.clipboard.writeText(String(value));setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{notify({title:'Copy failed',variant:'error'});}}}>{copied?<Check className="size-3.5"/>:<Copy className="size-3.5"/>}</button>}</div></div>;
}
export const select="h-9 w-full rounded-md border bg-background px-2 text-sm";
