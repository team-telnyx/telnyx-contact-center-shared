// Text extraction only: HTML is rendered separately in a sandboxed iframe.
// Tags are removed until the result stops changing, because a single pass over
// `<<b>b>` leaves a live `<b>` behind. Entities are decoded in one pass, so
// the literal text `&amp;lt;` decodes to `&lt;` and not to `<`.
function stripTagsUntilStable(value) {
  let previous;
  let current = value;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, "");
  } while (current !== previous);
  return current;
}

export function emailHtmlText(html) {
  const withBreaks = String(html||'').replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6])\b[^>]*>/gi,'\n');
  return stripTagsUntilStable(withBreaks)
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,value)=>{
      if(value[0]!=='#')return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[value.toLowerCase()]||whole;
      const code=value[1].toLowerCase()==='x'?parseInt(value.slice(2),16):Number(value.slice(1));
      return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
    }).replace(/\n{3,}/g,'\n\n').trim();
}

// Inline display permits raster image signatures only, never active SVG/HTML.
export function emailRasterType(bytes) {
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=6&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
  if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return 'image/webp';
  return null;
}
