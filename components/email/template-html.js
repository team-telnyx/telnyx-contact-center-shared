const tags=new Set(['A','B','BLOCKQUOTE','BR','DIV','EM','H1','H2','H3','H4','HR','I','LI','OL','P','PRE','S','SPAN','STRONG','TABLE','TBODY','TD','TH','THEAD','TR','U','UL']);
const styles=['background-color','color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','vertical-align','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','border','border-width','border-style','border-color','border-radius','border-collapse','width','max-width','min-width','height','display'];

// Template layouts need table and inline styles that the generic rich-text
// sanitizer intentionally drops. Keep an explicit email-only allowlist.
export function sanitizeEmailTemplateHtml(source='', {images=false,remote=false}={}){
  if(typeof DOMParser==='undefined')return '';
  const doc=new DOMParser().parseFromString(String(source),'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta,base,svg,math,video,audio,source').forEach(node=>node.remove());
  for(const node of [...doc.body.querySelectorAll('*')]){
    if(node.tagName==='IMG'){
      if(!images){node.remove();continue;}
      const src=node.getAttribute('data-email-src')||node.getAttribute('src')||'',alt=node.getAttribute('alt')||'Email image';
      for(const attr of [...node.attributes])node.removeAttribute(attr.name);
      node.setAttribute('alt',alt);node.style.maxWidth='100%';
      if(/^(https:\/\/|cid:)/i.test(src)){node.setAttribute('data-email-src',src);if(remote&&/^https:\/\//i.test(src))node.setAttribute('src',src);}
      continue;
    }
    if(!tags.has(node.tagName)){node.replaceWith(...node.childNodes);continue;}
    const inline=styles.map(key=>[key,node.style.getPropertyValue(key)]).filter(([,value])=>value&&!/url\s*\(|expression|@import|javascript|var\s*\(/i.test(value));
    for(const attr of [...node.attributes]){
      const name=attr.name.toLowerCase(),value=attr.value.trim();
      const link=node.tagName==='A'&&name==='href'&&(/^https:\/\//i.test(value)||/^\{\{\s*[a-z_]\w*(?:\.\w+)*\s*\}\}$/i.test(value));
      if(link||name==='title'||images&&node.tagName==='BLOCKQUOTE'&&name==='data-email-forward'&&value==='true'||['colspan','rowspan'].includes(name)&&/^\d{1,2}$/.test(value))continue;
      node.removeAttribute(attr.name);
    }
    for(const [key,value] of inline)node.style.setProperty(key,value);
    if(node.tagName==='A'){node.setAttribute('target','_blank');node.setAttribute('rel','noopener noreferrer');}
  }
  return doc.body.innerHTML.trim();
}
