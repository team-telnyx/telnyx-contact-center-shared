// Shared, browser-safe recipient normalization. Do not collapse plus tags or dots.
export const splitRecipients=value=>String(value||'').split(/[,;\n]/).map(v=>v.trim()).filter(Boolean);
export const recipientKey=value=>String(value||'').trim().toLowerCase();
export const validRecipient=value=>/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)&&value.length<=254;
export function addRecipients(draft,field,values) {
  const next=splitRecipients(draft[field]),existing=new Set(next.map(recipientKey)),duplicates=[];
  for(const raw of values){
    const value=raw.trim(),key=recipientKey(value);
    const other=['to','cc','bcc'].find(f=>f!==field&&splitRecipients(draft[f]).some(v=>recipientKey(v)===key));
    if(other){duplicates.push({address:value,field:other});continue;}
    if(!existing.has(key)){next.push(value);existing.add(key);}
  }
  return {value:next.join(', '),duplicates};
}
