"use client";
import { useState } from 'react';
import { useUiText } from '@/components/i18n/use-ui-text';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
export default function VideoConferenceHistory({widgetId}) {
  const tUi=useUiText(),[result,setResult]=useState(null),[selected,setSelected]=useState(null);
  async function load(){setResult({status:'loading'});try{const r=await fetch(`/api/video/sessions?widgetId=${encodeURIComponent(widgetId)}`,{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error);setResult({status:'ready',sessions:data.sessions});}catch(error){setResult({status:'error',error:error.message});}}
  return <div className="space-y-2 rounded border p-3">
    <Button type="button" variant="outline" size="sm" onClick={load}>{tUi("Recent video sessions and recordings")}</Button>
    {result?.status==='loading'&&<Skeleton className="h-24 w-full"/>}
    {result?.status==='error'&&<p role="alert" className="text-sm text-destructive">{result.error}</p>}
    {result?.status==='ready'&&<div className="max-h-80 space-y-3 overflow-y-auto text-xs">{!result.sessions.length&&<p>{tUi("No video sessions yet")}</p>}{result.sessions.map(s=><div key={s.id} className="space-y-1 border-b pb-2"><p>{s.customer_name||tUi("Website visitor")} · {new Date(s.created_at).toLocaleString()} · {s.state}</p><p>{tUi("Recording")}: {s.composition_state||tUi("Unavailable")}</p>{s.composition_error&&<p role="status">{s.composition_error}</p>}{s.recordings.map(r=><Button key={r.id} type="button" size="sm" variant="outline" onClick={()=>setSelected(r)}>{tUi(r.kind==='composition'?'Play conference recording':'Play participant recording')}</Button>)}</div>)}</div>}
    {selected&&<div className="space-y-2"><video controls autoPlay className="w-full rounded bg-black" src={selected.url}/><Button type="button" size="sm" variant="ghost" onClick={()=>setSelected(null)}>{tUi("Close")}</Button></div>}
  </div>;
}
