"use client";
import { useEffect,useRef,useState } from "react";
import { Loader2,MapPin,Minus,Plus,Search,Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import LocationMapPreview from "./LocationMapPreview";
import { clampZoom,parseLatitude,parseLongitude } from "@/lib/contact-center/maps.mjs";

const EMPTY={latitude:"",longitude:"",name:"",address:""};
// Address search (server-side geocoder) with a map preview; the agent can also
// type coordinates. The server validates again before sending.
export default function WhatsAppLocationDialog({open,onOpenChange,onSend,busy,initial=null}){
  const [query,setQuery]=useState(""),[results,setResults]=useState([]),[searching,setSearching]=useState(false),[error,setError]=useState("");
  const [location,setLocation]=useState(EMPTY),[zoom,setZoom]=useState(15);
  const timer=useRef(null),latest=useRef(0);
  useEffect(()=>{if(open){setLocation(initial?{...EMPTY,...initial}:EMPTY);setQuery("");setResults([]);setError("");setZoom(15);}},[open,initial]);
  useEffect(()=>{
    if(!open)return;
    const text=query.trim();
    if(text.length<3){setResults([]);setSearching(false);return;}
    clearTimeout(timer.current);
    timer.current=setTimeout(async()=>{
      const ticket=++latest.current;setSearching(true);setError("");
      try{const response=await fetch(`/api/contact-center/media/geocode?q=${encodeURIComponent(text)}`,{cache:"no-store"});const data=await response.json();
        if(ticket!==latest.current)return;if(!response.ok)throw Error(data.error||"Address search failed");setResults(data.results||[]);}
      catch(reason){if(ticket===latest.current){setResults([]);setError(reason.message);}}
      finally{if(ticket===latest.current)setSearching(false);}
    },400);
    return()=>clearTimeout(timer.current);
  },[query,open]);
  let parsed=null;try{if(String(location.latitude).trim()&&String(location.longitude).trim())parsed={latitude:parseLatitude(location.latitude),longitude:parseLongitude(location.longitude)};}catch{parsed=null;}
  const coordinatesInvalid=Boolean(String(location.latitude).trim()||String(location.longitude).trim())&&!parsed;
  function choose(result){setLocation({latitude:String(result.latitude),longitude:String(result.longitude),name:result.name||"",address:result.address||result.label||""});setResults([]);setQuery(result.label||result.name||"");setError("");}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-2xl" data-testid="whatsapp-location-dialog">
    <DialogHeader><DialogTitle>Send a location</DialogTitle><DialogDescription>Search for an address or type coordinates. The customer receives a map pin with the name and address you enter.</DialogDescription></DialogHeader>
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
      <Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search for an address or place" aria-label="Address search" className="pl-8" autoComplete="off"/>
      {searching&&<Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true"/>}
      {results.length>0&&<ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md" role="listbox" aria-label="Address suggestions" data-testid="whatsapp-location-results">
        {results.map(result=><li key={result.id}><button type="button" role="option" aria-selected="false" className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={()=>choose(result)}><MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"/><span><span className="block font-medium">{result.name||result.label}</span><span className="block text-muted-foreground">{result.address||result.label}</span></span></button></li>)}
      </ul>}
    </div>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1.5 text-xs font-medium">Latitude<Input value={location.latitude} onChange={e=>setLocation({...location,latitude:e.target.value})} placeholder="52.2297" inputMode="decimal" aria-label="Latitude" data-testid="whatsapp-location-latitude"/></label>
          <label className="block space-y-1.5 text-xs font-medium">Longitude<Input value={location.longitude} onChange={e=>setLocation({...location,longitude:e.target.value})} placeholder="21.0122" inputMode="decimal" aria-label="Longitude" data-testid="whatsapp-location-longitude"/></label>
        </div>
        {coordinatesInvalid&&<p className="text-xs text-destructive">Latitude must be between -90 and 90 and longitude between -180 and 180.</p>}
        <label className="block space-y-1.5 text-xs font-medium">Name<Input value={location.name} onChange={e=>setLocation({...location,name:e.target.value})} placeholder="e.g. Telnyx office" maxLength={120} aria-label="Location name"/></label>
        <label className="block space-y-1.5 text-xs font-medium">Address<Input value={location.address} onChange={e=>setLocation({...location,address:e.target.value})} placeholder="Street, city" maxLength={240} aria-label="Location address"/></label>
      </div>
      <div className="space-y-2">
        {parsed?<LocationMapPreview latitude={parsed.latitude} longitude={parsed.longitude} zoom={zoom} width={280} height={180} label="Selected location"/>
          :<div className="flex aspect-[280/180] w-full max-w-[280px] items-center justify-center rounded-lg border border-dashed text-center text-xs text-muted-foreground">Pick an address or enter coordinates to preview the map.</div>}
        <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>Zoom {zoom}</span><span className="flex gap-1"><Button type="button" variant="outline" size="icon" className="size-7" aria-label="Zoom out" disabled={!parsed||zoom<=3} onClick={()=>setZoom(clampZoom(zoom-1))}><Minus className="size-3.5"/></Button><Button type="button" variant="outline" size="icon" className="size-7" aria-label="Zoom in" disabled={!parsed||zoom>=18} onClick={()=>setZoom(clampZoom(zoom+1))}><Plus className="size-3.5"/></Button></span></div>
      </div>
    </div>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={()=>onOpenChange(false)}>Cancel</Button>
      <Button type="button" size="sm" className="bg-green-600 text-white hover:bg-green-700" disabled={busy||!parsed} data-testid="whatsapp-location-send" onClick={()=>onSend({latitude:parsed.latitude,longitude:parsed.longitude,name:location.name.trim(),address:location.address.trim()})}>{busy?<Loader2 className="mr-1 size-3.5 animate-spin"/>:<Send className="mr-1 size-3.5"/>}Send location</Button></div>
  </DialogContent></Dialog>;
}
