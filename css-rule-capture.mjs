// Preserve CSSOM provenance, scope and order. No per-node CDP matching.
export async function captureStylesheets(page) {
  return page.evaluate(()=>{
    const stylesheets=[];const seen=new Map();
    function sheet(sheet,scope,adopted=false,owner=null) {
      if(!sheet)return;
      // The same constructable sheet may be adopted by multiple shadow roots.
      const key=scope+':'+(seen.get(sheet) || seen.size+1);if(!seen.has(sheet))seen.set(sheet,seen.size+1);
      if(stylesheets.some(s=>s.key===key))return;
      const item={key,id:`sheet-${stylesheets.length+1}`,order:stylesheets.length,scope,adopted,url:sheet.href || null,baseUrl:owner?.baseURI || document.baseURI,disabled:sheet.disabled,media:sheet.media?.mediaText || '',source:'cssom',sourceRange:null,missingReason:'Original source position unavailable',readError:null,rules:[]};
      stylesheets.push(item);
      try{item.rules=[...sheet.cssRules].map(r=>r.cssText);}
      catch(error){item.readError='CSSOM rules inaccessible: '+error.name;}
      if(owner?.localName==='style')item.inlineText=owner.textContent;
      try{for(const rule of sheet.cssRules)if(rule.styleSheet)readImport(rule.styleSheet,scope,item.id);}catch{}
    }
    function readImport(imported,scope,parent){sheet(imported,scope);const item=stylesheets.find(s=>s.scope===scope&&s.url===imported.href);if(item)item.importedBy=parent;}
    function root(scopeRoot,scope) {
      for(const el of scopeRoot.querySelectorAll('style,link[rel~=stylesheet]'))sheet(el.sheet,scope,false,el);
      for(const s of scopeRoot.adoptedStyleSheets || [])sheet(s,scope,true);
      let i=0;for(const el of scopeRoot.querySelectorAll('*'))if(el.shadowRoot)root(el.shadowRoot,scope+'/shadow-'+(++i));
    }
    root(document,'document');return {stylesheets};
  });
}
