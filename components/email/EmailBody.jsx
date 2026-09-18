"use client";
import { useEffect,useMemo,useState } from 'react';
import { emailPreviewSettings } from '@/lib/email/preview-settings.mjs';
import { emailHtmlText } from '@/lib/email/content.mjs';

export const textToEmailHtml = text => String(text||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

export default function EmailBody({message,settings,fill=false}) {
  const policy=emailPreviewSettings(settings);
  const showHtml=policy.format==='html'&&Boolean(message.html_body),remote=policy.loadRemoteImages;
  const showInlineImages=policy.showInlineImages;
  const [retainedImages,setRetainedImages]=useState(null);
  const files=JSON.stringify((message.attachments||[]).filter(a=>a.content_id&&a.url));
  useEffect(()=>{
    if(!showHtml||!showInlineImages)return;
    const controller=new AbortController();
    void Promise.all(JSON.parse(files).slice(0,20).map(async file=>{
      try{
        const response=await fetch(`${file.url}${file.url.includes('?')?'&':'?'}inline=1`,{cache:'no-store',signal:controller.signal});
        if(!response.ok||!/^image\/(png|jpeg|gif|webp)$/.test(response.headers.get('content-type')||''))return null;
        const blob=await response.blob();if(blob.size>5_000_000)return null;
        const value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
        return [file.content_id.replace(/^<|>$/g,''),value];
      }catch{return null;}
    })).then(values=>{if(!controller.signal.aborted)setRetainedImages({files,images:Object.fromEntries(values.filter(Boolean))});});
    return()=>controller.abort();
  },[files,showHtml,showInlineImages]);
  const source=useMemo(()=>{
    if(!showHtml||typeof DOMParser==='undefined')return '';
    const inlineImages=showInlineImages&&retainedImages?.files===files?retainedImages.images:{};
    const doc=new DOMParser().parseFromString(message.html_body||'','text/html');
    doc.querySelectorAll('script,iframe,object,embed,form,input,button,link,meta,base,svg,math,video,audio,source').forEach(n=>n.remove());
    doc.querySelectorAll('*').forEach(node=>{
      for(const attr of [...node.attributes]){
        if(attr.name.startsWith('on')||['srcset','action','formaction','srcdoc','background'].includes(attr.name))node.removeAttribute(attr.name);
      }
      if(node.tagName==='IMG'){
        const src=node.getAttribute('src')||'',inline=src.startsWith('cid:')&&inlineImages[src.slice(4).replace(/^<|>$/g,'')];
        if(inline)node.setAttribute('src',inline);
        else if(!remote||!/^https:\/\//i.test(src))node.removeAttribute('src');
      }
      if(node.tagName==='A'){node.removeAttribute('href');node.removeAttribute('target');}
    });
    const imageSources=[showInlineImages?'data:':'',remote?'https:':''].filter(Boolean).join(' ')||"'none'";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; base-uri 'none'; form-action 'none'"><style>body{font:14px/1.65 Arial,sans-serif;color:#182323;background:white;overflow-wrap:anywhere;margin:16px}img,table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${doc.body.innerHTML}</body></html>`;
  },[message.html_body,remote,showHtml,showInlineImages,retainedImages,files]);
  return <div className={fill?"flex min-h-0 flex-1 flex-col overflow-hidden":undefined}>
    {showHtml?<iframe title={`Email body ${message.id}`} sandbox="" referrerPolicy="no-referrer" srcDoc={source} className={fill?"min-h-64 w-full flex-1 rounded-lg border bg-white":"h-64 w-full rounded-lg border bg-white"}/>:<p className={`${fill?"min-h-0 flex-1 overflow-y-auto ":""}whitespace-pre-wrap break-words text-[13px] leading-relaxed`}>{message.body||emailHtmlText(message.html_body)||'This email has no text content.'}</p>}
  </div>;
}
