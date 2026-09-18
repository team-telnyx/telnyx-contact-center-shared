"use client";

import { useState } from "react";
import { Download,ExternalLink,FileImage,FileText,Maximize2,Music2,Play } from "lucide-react";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import DocumentPreview from "@/components/documents/DocumentPreview";
import { documentPreviewKind, DOCUMENT_PREVIEW_SIZE } from "@/lib/documents/preview-types.mjs";

export const fileSize=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} MB`:`${Math.max(1,Math.ceil((bytes||0)/1024))} KB`;
function kind(file){return file.content_type?.split("/")[0]||"file";}
function ImagePreview({url,name}){
  const [loaded,setLoaded]=useState(false),[error,setError]=useState(false);
  return <div className="relative grid min-h-48 max-w-full place-items-center">
    {!loaded&&!error&&<Skeleton className="absolute inset-0 min-w-48" role="status" aria-label="Loading image preview"/>}
    {error?<p role="alert" className="p-6 text-center text-sm text-muted-foreground">Image preview is unavailable. You can download the original file below.</p>:
      // Authenticated attachment URLs use the current browser session.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={name} onLoad={()=>setLoaded(true)} onError={()=>setError(true)} className={`h-auto w-auto max-h-[60dvh] max-w-full rounded-lg object-contain ${loaded?"":"opacity-0"}`}/>}
  </div>;
}
export default function ChatAttachments({files=[],presentation="media"}){
  const [preview,setPreview]=useState(null);
  const documentPreview=preview&&documentPreviewKind(preview.content_type,preview.name);
  const previewUrl=preview?.previewUrl||preview?.url;
  const showMedia=presentation==="media";
  return <>
    <div className={`flex min-w-0 max-w-full gap-2 ${showMedia?"flex-col items-start":"flex-wrap"}`} aria-label="Attachments">
      {files.map(file=><div key={file.id||file.url} data-attachment-card={kind(file)} className="h-fit w-fit min-w-0 max-w-[min(100%,20rem)] overflow-hidden rounded-xl border border-border/70 bg-background/80 text-foreground">
        {showMedia&&(kind(file)==="image"?<button type="button" className="group/image relative grid w-full place-items-center bg-muted/30" onClick={()=>setPreview(file)} aria-label={`Preview ${file.name}`}>
          {/* Authenticated attachment URLs must use the browser session directly. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={file.url} alt={file.name} className="block h-auto w-auto max-h-64 max-w-full object-contain" loading="lazy"/>
          <span className="absolute right-2 top-2 rounded-lg bg-black/45 p-1.5 text-white"><Maximize2 className="size-3.5"/></span>
        </button>:kind(file)==="audio"?<div className="p-2"><audio src={file.url} controls preload="metadata" className="h-9 w-64 min-w-0 max-w-full" aria-label={file.name}/></div>
          :kind(file)==="video"?<div className="relative bg-black"><video src={file.url} controls preload="metadata" className="h-auto w-auto max-h-64 max-w-full object-contain" aria-label={file.name}/></div>:null)}
        <div className="flex min-w-0 items-center gap-2 p-2.5">
          <button type="button" onClick={()=>setPreview(file)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-label={`Preview ${file.name}`}>
            <span className="shrink-0 rounded-lg bg-muted p-2">{kind(file)==="audio"?<Music2 className="size-4"/>:kind(file)==="video"?<Play className="size-4"/>:kind(file)==="image"?<FileImage className="size-4"/>:<FileText className="size-4"/>}</span>
            <span className="min-w-0"><span className="block truncate text-xs font-medium" title={file.name}>{file.name}</span><span className="block truncate text-[10px] text-muted-foreground" title={file.content_type}>{fileSize(file.byte_size)} · {file.name?.split('.').pop()?.toUpperCase()||kind(file)}</span></span>
          </button>
          <a href={file.url} download={file.name} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-lg p-2 hover:bg-muted" aria-label={`Download ${file.name}`}><Download className="size-3.5"/></a>
        </div>
      </div>)}
    </div>
    <Dialog open={Boolean(preview)} onOpenChange={open=>{if(!open)setPreview(null);}}>
      <DialogContent className={`flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 ${documentPreview?"max-w-none sm:max-w-none":"sm:max-w-4xl"}`}
        style={documentPreview?{width:`min(calc(100vw - 2rem), max(${DOCUMENT_PREVIEW_SIZE.widthPercent}vw, 640px))`,height:`${DOCUMENT_PREVIEW_SIZE.heightPercent}dvh`}:undefined}>
        <DialogHeader className="shrink-0 border-b p-5 pr-12"><DialogTitle className="truncate">{preview?.name}</DialogTitle><DialogDescription className="truncate">{preview?.content_type} · {fileSize(preview?.byte_size)}</DialogDescription></DialogHeader>
        <div className={`grid min-h-0 min-w-0 flex-1 place-items-center overflow-auto bg-muted/30 ${documentPreview?"":"min-h-48 p-4"}`}>
          {documentPreview?<DocumentPreview url={previewUrl} name={preview.name} mimeType={preview.content_type}/>
            :preview&&kind(preview)==="image"?<ImagePreview key={previewUrl} url={previewUrl} name={preview.name}/>
            :preview&&kind(preview)==="video"?<video src={previewUrl} controls autoPlay={false} className="max-h-[65dvh] w-full rounded-lg"/>
              :preview&&kind(preview)==="audio"?<audio src={previewUrl} controls className="w-full max-w-xl"/>
                :<div className="space-y-3 p-10 text-center text-muted-foreground"><FileText className="mx-auto size-12"/><p className="text-sm">Download this file to open it in its application.</p></div>}
        </div>
        <div className="flex shrink-0 justify-end gap-3 border-t p-3 text-xs font-medium"><a className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 hover:bg-muted" href={preview?.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4"/>Open in new tab</a>
          <a className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-primary-foreground" href={preview?.url} download={preview?.name} target="_blank" rel="noopener noreferrer"><Download className="size-4"/>Download</a></div>
      </DialogContent>
    </Dialog>
  </>;
}
