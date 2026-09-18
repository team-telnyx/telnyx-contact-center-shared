"use client";
import { useState } from "react";
import { Download,Loader2,Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";

// Royalty-free photo search for the agent composer. The chosen photo is fetched
// through the server proxy and handed back as a File the composer attaches.
export default function PexelsPickerDialog({open,onOpenChange,onPick}){
  const [query,setQuery]=useState(""),[photos,setPhotos]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState(""),[downloading,setDownloading]=useState(null);
  async function search(event){
    event?.preventDefault();
    const text=query.trim();if(text.length<2){setError("Enter at least 2 characters to search Pexels.");return;}
    setLoading(true);setError("");
    try{const response=await fetch(`/api/contact-center/media/pexels?query=${encodeURIComponent(text)}&perPage=30`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw Error(data.error||"Pexels search failed");setPhotos(data.photos||[]);}
    catch(reason){setPhotos([]);setError(reason.message);}finally{setLoading(false);}
  }
  async function pick(photo){
    setDownloading(photo.id);setError("");
    try{
      const response=await fetch(`/api/contact-center/media/pexels?photoId=${encodeURIComponent(photo.id)}`,{cache:"no-store"});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||"Pexels download failed");}
      const blob=await response.blob();const name=response.headers.get("x-pexels-filename")||`pexels-${photo.id}.jpg`;
      onPick(new File([blob],name,{type:blob.type||"image/jpeg"}),photo);onOpenChange(false);
    }catch(reason){setError(reason.message);}finally{setDownloading(null);}
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-3xl" data-testid="pexels-picker">
    <DialogHeader><DialogTitle>Search in Pexels</DialogTitle><DialogDescription>Find a royalty-free photo and attach it to the reply. Pexels photos are free to use; attribution is appreciated but not required.</DialogDescription></DialogHeader>
    <form className="grid grid-cols-[1fr_auto] gap-2" onSubmit={search}><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="e.g. customer support, city, nature" aria-label="Pexels search"/><Button type="submit" size="sm" disabled={loading}>{loading?<Loader2 className="mr-1 size-3.5 animate-spin"/>:<Search className="mr-1 size-3.5"/>}Search</Button></form>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">{photos.map(photo=><div key={photo.id} className="group relative overflow-hidden rounded-lg border bg-muted" style={{backgroundColor:photo.avg_color||undefined}}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.src.medium||photo.src.small} alt={photo.alt||photo.title} className="aspect-[4/3] w-full object-cover" loading="lazy"/>
      <button type="button" className="absolute inset-0 flex items-end justify-between bg-gradient-to-t from-black/60 to-transparent p-2 text-left text-[10px] text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100" disabled={downloading===photo.id} onClick={()=>void pick(photo)} aria-label={`Attach photo by ${photo.photographer}`}><span className="truncate">{photo.photographer}</span>{downloading===photo.id?<Loader2 className="size-4 animate-spin"/>:<Download className="size-4"/>}</button>
    </div>)}</div>
    {!photos.length&&!loading&&<p className="text-xs text-muted-foreground">No Pexels results yet. Try a search term above.</p>}
  </DialogContent></Dialog>;
}
