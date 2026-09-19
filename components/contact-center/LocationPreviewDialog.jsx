"use client";
import { ExternalLink,MapPin } from "lucide-react";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { googleMapsApiKey,googleMapsEmbedUrl,googleMapsLink } from "@/lib/contact-center/maps.mjs";

const safe=(fn,value)=>{try{return fn(value);}catch{return null;}};
// Larger, interactive Google map for a shared location, opened from the bubble
// thumbnail like the attachment preview. The full map opens from here, in a new tab.
export default function LocationPreviewDialog({location,open,onOpenChange}){
  const google=location?safe(googleMapsLink,location):null;
  // Next inlines the public name at build time; the helper keeps the fallback.
  const embed=location?safe(googleMapsEmbedUrl,{...location,zoom:15,apiKey:googleMapsApiKey({NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY})}):null;
  const title=location?.name||"Shared location";
  const subtitle=location?[location.address,`${location.latitude}, ${location.longitude}`].filter(Boolean).join(" · "):"";
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl" data-testid="location-preview-dialog">
      <DialogHeader className="shrink-0 border-b p-5 pr-12"><DialogTitle className="flex items-center gap-2 truncate"><MapPin className="size-4 shrink-0 text-red-600" aria-hidden="true"/>{title}</DialogTitle><DialogDescription className="truncate">{subtitle}</DialogDescription></DialogHeader>
      <div className="min-h-0 min-w-0 flex-1 bg-muted/30 p-4">
        {open&&embed?<iframe src={embed} title={`Map of ${title}`} className="block h-[60dvh] w-full rounded-lg border bg-muted" loading="lazy" allowFullScreen referrerPolicy="no-referrer-when-downgrade" data-testid="location-google-map"/>
          :<p className="p-6 text-center text-sm text-muted-foreground">Map preview is unavailable for this location.</p>}
      </div>
      <div className="flex shrink-0 justify-end gap-3 border-t p-3 text-xs font-medium">
        {google&&<a className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-primary-foreground" href={google} target="_blank" rel="noopener noreferrer" data-testid="location-open-maps"><ExternalLink className="size-4"/>Open in Google Maps</a>}
      </div>
    </DialogContent>
  </Dialog>;
}
