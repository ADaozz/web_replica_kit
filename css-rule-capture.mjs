// Preserve CSSOM provenance, scope and order. No per-node CDP matching.
export async function captureStylesheets(page) {
  return page.evaluate(()=>{
    const stylesheets=[];const seen=new Map();
    function sheet(sheet,scope,adopted=false,owner=null) {
      if(!sheet)return;
      // The same constructable sheet may be adopted by multiple shadow roots.
      const key=scope+':'+(seen.get(sheet) || seen.size+1);if(!seen.has(sheet))seen.set(sheet,seen.size+1);
      if(stylesheets.some(s=>s.key===key))return;
      const item={key,id:`sheet-${stylesheets.length+1}`,order:stylesheets.length,scope,adopted,url:sheet.href || null,baseUrl:owner?.baseURI || document.baseURI,disabled:sheet.disabled,media:sheet.media?.mediaText || '',source:'cssom',sourceRange:null,missingReason:null,sourcePositionMissingReason:'Original source position unavailable',rules:[]};
      stylesheets.push(item);
      try{item.rules=[...sheet.cssRules].map(r=>r.cssText);}
      catch(error){item.missingReason='CSSOM rules inaccessible: '+error.name;}
      if(owner?.localName==='style')item.inlineText=owner.textContent;
      try{for(const rule of sheet.cssRules)if(rule.styleSheet)readImport(rule.styleSheet,scope,item.id);}catch{}
    }
    function readImport(imported,scope,parent){sheet(imported,scope);const item=stylesheets.find(s=>s.scope===scope&&s.url===imported.href);if(item)item.importedBy=parent;}
    function root(root,scope) {
      for(const el of root.querySelectorAll('style,link[rel~=stylesheet]'))sheet(el.sheet,scope,false,el);
      for(const s of root.adoptedStyleSheets || [])sheet(s,scope,true);
      let i=0;for(const el of root.querySelectorAll('*'))if(el.shadowRoot)rootWalk(el.shadowRoot,scope+'/shadow-'+(++i));
    }
    const rootWalk=root;root(document,'document');return {stylesheets};
  });
}
