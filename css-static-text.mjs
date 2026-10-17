// Runs in the browser. Retain authored text for unchanged rules: Chromium can
// serialize pending shorthand values (font:var(...)) into empty longhands.
export function staticSheetText(sheet,authored) {
  const current=[...sheet.cssRules];
  if(authored===undefined)return current.map(r=>r.cssText).join('\n');
  const detached=document.implementation.createHTMLDocument('');
  const style=detached.createElement('style');style.textContent=authored;detached.head.append(style);
  const original=[...style.sheet.cssRules];
  if(original.map(r=>r.cssText).join('\n')===current.map(r=>r.cssText).join('\n'))return authored;
  // Split authored top-level rules with strings/comments/parentheses intact.
  function split(text) {
    const chunks=[];let start=0,depth=0,parens=0,quote='',comment=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i],next=text[i+1];
      if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}
      if(quote){if(c==='\\')i++;else if(c===quote)quote='';continue;}
      if(c==='/'&&next==='*'){comment=true;i++;continue;}
      if(c==='"'||c==="'"){quote=c;continue;}
      if(c==='('||c==='[')parens++;if(c===')'||c===']')parens--;
      if(parens)continue;
      if(c==='{')depth++;
      if(c==='}')depth--;
      if((c==='}'&&depth===0)||(c===';'&&depth===0)){chunks.push(text.slice(start,i+1));start=i+1;}
    }
    return chunks;
  }
  const raw=split(authored);
  if(raw.length!==original.length)return current.map(r=>r.cssText).join('\n');
  const originals=new Map(original.map((r,i)=>[r.cssText,raw[i]]));
  return current.map(r=>originals.get(r.cssText) ?? r.cssText).join('\n');
}
