"use client";
import { useEffect,useMemo,useRef,useState } from "react";
import { MapPin } from "lucide-react";
import { MAP_ATTRIBUTION,MAP_ATTRIBUTION_URL,MAP_TILE_SIZE,staticMapLayout } from "@/lib/contact-center/maps.mjs";

// Small static map centred on a point: a mosaic of tiles clipped to the card
// with a pin in the middle. No map library and no API key are needed.
export default function LocationMapPreview({latitude,longitude,zoom=15,width=280,height=150,className="",label="Map preview"}){
  const [failed,setFailed]=useState({}),[scale,setScale]=useState(1);
  const frame=useRef(null);
  const layout=useMemo(()=>{try{return staticMapLayout({latitude,longitude,zoom,width,height});}catch{return null;}},[latitude,longitude,zoom,width,height]);
  // The mosaic is laid out in pixels; shrink it to the space the card gets.
  useEffect(()=>{
    const node=frame.current;if(!node||typeof ResizeObserver==="undefined")return;
    // ResizeObserver reports the initial size on observe, so no synchronous setState is needed.
    const observer=new ResizeObserver(()=>setScale(Math.min(1,node.clientWidth/width)||1));observer.observe(node);
    return()=>observer.disconnect();
  },[width]);
  if(!layout)return null;
  return <div ref={frame} className={`relative overflow-hidden rounded-lg border border-black/10 bg-slate-200 dark:border-white/10 dark:bg-slate-700 ${className}`} style={{width:"100%",maxWidth:layout.width,aspectRatio:`${layout.width} / ${layout.height}`}} role="img" aria-label={`${label}: ${layout.latitude}, ${layout.longitude}`} data-testid="location-map" data-zoom={layout.zoom}>
    <div className="absolute inset-0" style={{width:layout.width,height:layout.height,transform:`scale(${scale})`,transformOrigin:"top left"}}>
      {layout.tiles.map(tile=>failed[tile.key]?null:
        // eslint-disable-next-line @next/next/no-img-element
        <img key={tile.key} src={tile.url} alt="" aria-hidden="true" loading="lazy" decoding="async" draggable={false} className="absolute max-w-none select-none" style={{left:tile.left,top:tile.top,width:MAP_TILE_SIZE,height:MAP_TILE_SIZE}} data-testid="location-map-tile" onError={()=>setFailed(current=>({...current,[tile.key]:true}))}/>)}
      <MapPin className="absolute size-7 -translate-x-1/2 -translate-y-full text-red-600 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]" style={{left:layout.pin.left,top:layout.pin.top}} aria-hidden="true" fill="currentColor" strokeWidth={1.5} stroke="white"/>
    </div>
    {/* Plain text: the preview may sit inside a link, and nested anchors are invalid. */}
    <span className="absolute bottom-0 right-0 rounded-tl bg-white/80 px-1 text-[8px] leading-3 text-slate-700 dark:bg-black/60 dark:text-slate-200" title={MAP_ATTRIBUTION_URL}>{MAP_ATTRIBUTION}</span>
  </div>;
}
