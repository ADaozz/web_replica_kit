import crypto from 'node:crypto';
import {EVIDENCE_SCHEMA_VERSION} from './evidence-schema.mjs';

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 24);

// Browser-side CSSOM is a separately labelled supplement, never a fabricated CDP source.
export function readCssomEvidence({ maxRules = 20000 } = {}) {
  const key = Symbol.for('web-replica-kit.identities');
  const ids = globalThis[key] ||= {documentId:globalThis.crypto?.randomUUID?.() || `${performance.timeOrigin}-${Math.random()}`,nodes:new WeakMap(),sheets:new WeakMap(),nextNode:0,nextSheet:0};
  const elementId = el => {if (!el) return null;if (!ids.nodes.has(el)) ids.nodes.set(el,`${ids.documentId}:e${++ids.nextNode}`);return ids.nodes.get(el);};
  const sheetId = sheet => {if (!ids.sheets.has(sheet)) ids.sheets.set(sheet,`${ids.documentId}:s${++ids.nextSheet}`);return ids.sheets.get(sheet);};
  const sheets = [], scopes = [], missing = [], seen = new Set();
  let ruleCount = 0;
  function readSheet(sheet) {
    const id = sheetId(sheet);
    if (seen.has(sheet)) return id;
    seen.add(sheet);
    const record = {id,channel:'cssom',href:sheet.href || null,ownerElementId:elementId(sheet.ownerNode),disabled:sheet.disabled,media:sheet.media?.mediaText || '',rules:[]};
    sheets.push(record);
    function rules(list, conditions = [], path = []) {
      const result = [];
      for (let index=0;index<list.length;index++) {
        if (++ruleCount>maxRules) {missing.push({kind:'cssom-rule-budget',limit:maxRules,sheetId:id});break;}
        const rule=list[index], kind=rule.constructor.name;
        const condition={kind,text:rule.conditionText ?? rule.name ?? rule.selectorText ?? rule.media?.mediaText ?? null,active:null};
        if (kind==='CSSMediaRule') condition.active=matchMedia(rule.conditionText).matches;
        if (kind==='CSSSupportsRule') condition.active=CSS.supports(rule.conditionText);
        const grouped=Boolean(rule.cssRules);
        const item={path:[...path,index],kind,selector:rule.selectorText ?? null,cssText:rule.cssText,conditions,
          declarations:rule.style ? [...rule.style].map(name=>({name,value:rule.style.getPropertyValue(name),important:rule.style.getPropertyPriority(name)==='important'})) : [],
          source:{url:sheet.href || null,range:null,missingReason:'CSSOM does not expose original source positions'}};
        if (rule.styleSheet) item.importedSheetId=readSheet(rule.styleSheet);
        if (grouped) item.children=rules(rule.cssRules,[...conditions,condition],item.path);
        result.push(item);
      }
      return result;
    }
    try {record.rules=rules(sheet.cssRules);} catch(error) {missing.push({kind:'cssom-rules-inaccessible',sheetId:id,reason:error.name});}
    return id;
  }
  const roots=[document];
  for (let index=0;index<roots.length;index++) {
    const root=roots[index];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    const ordinary=root.styleSheets ? [...root.styleSheets] : [...root.querySelectorAll('style,link[rel="stylesheet"]')].map(el=>el.sheet).filter(Boolean);
    scopes.push({id:root.host ? `${elementId(root.host)}:shadow` : `${ids.documentId}:document`,kind:root.host?'open-shadow':'document',hostElementId:elementId(root.host),
      styleSheets:ordinary.map(readSheet),adoptedStyleSheets:[...(root.adoptedStyleSheets || [])].map(readSheet)});
  }
  return {documentId:ids.documentId,scopes,sheets,missing,ruleCount};
}

function resolveElements(selectors) {
  return selectors.map(selector=>{
    let root=document;
    const parts=selector.split('>>>').map(part=>part.trim());
    for (let index=0;index<parts.length;index++) {
      const matches=root?.querySelectorAll(parts[index]);
      if (matches?.length!==1) return null;
      const el=matches[0];
      if (index===parts.length-1) return el;
      root=el.shadowRoot;
    }
    return null;
  });
}

export async function createCssRuleCollector(page, { maxNodes = 1000, maxRules = 20000, maxSheetBytes = 12*1024*1024 } = {}) {
  const sheets=new Map(), rules=new Map(), snapshots=[], cssomSnapshots=[], variableElements=[], resolvedVariableSets=new Map(), missing=[];
  const sessions=new Map(), frameSessions=new Map();
  let main=null, revision=null, captureSequence=0;
  const missingKeys=new Set();
  function gap(item) {
    const key=JSON.stringify(item);
    if (!missingKeys.has(key)) {missingKeys.add(key);missing.push(item);}
  }
  async function attach(target) {
    const session=await page.context().newCDPSession(target);
    const tree=await session.send('Page.getFrameTree');
    const scope=tree.frameTree.frame.id;
    if (sessions.has(scope)) {await session.detach();return sessions.get(scope);}
    const info={session,scope,headers:new Map(),tree:tree.frameTree};
    sessions.set(scope,info);
    session.on('CSS.styleSheetAdded',({header})=>info.headers.set(header.styleSheetId,{...header,active:true}));
    session.on('CSS.styleSheetRemoved',({styleSheetId})=>{const header=info.headers.get(styleSheetId);if(header)header.active=false;});
    await session.send('DOM.enable');await session.send('CSS.enable');await session.send('Page.enable');
    return info;
  }
  try {main=await attach(page);} catch(error) {gap({kind:'cdp-unavailable',reason:String(error.message)});}
  async function forFrame(frame,index) {
    if (!main) return null;
    let info=main;
    if (index) {
      if (!frameSessions.has(frame)) {
        try {frameSessions.set(frame,await attach(frame));}
        catch {frameSessions.set(frame,main);}
      }
      info=frameSessions.get(frame);
    }
    let tree=(await info.session.send('Page.getFrameTree')).frameTree;
    if (info.scope===main.scope && index) {
      const path=[];
      for (let cursor=frame;cursor.parentFrame();cursor=cursor.parentFrame()) path.unshift(cursor.parentFrame().childFrames().indexOf(cursor));
      for (const child of path) tree=tree?.childFrames?.[child];
    }
    if (!tree) {gap({kind:'frame-context-unresolved',frameIndex:index});return null;}
    try {
      const {executionContextId}=await info.session.send('Page.createIsolatedWorld',{frameId:tree.frame.id,worldName:'web-replica-kit-css-reader'});
      return {...info,frameId:tree.frame.id,contextId:executionContextId};
    } catch(error) {gap({kind:'frame-context-unavailable',frameIndex:index,reason:String(error.message)});return null;}
  }
  async function sheetVersion(info,styleSheetId,stateId) {
    const id=`${info.scope}:sheet:${styleSheetId}`;
    const header=info.headers.get(styleSheetId) || null;
    let record=sheets.get(id);
    // Only real stylesheet headers establish records before a successful text read.
    if(!record && header){record={id,channel:'cdp',header,versions:[]};sheets.set(id,record);}
    try {
      const {text}=await info.session.send('CSS.getStyleSheetText',{styleSheetId});
      if(Buffer.byteLength(text)>maxSheetBytes){gap({kind:'stylesheet-byte-budget',stylesheetId:id,limit:maxSheetBytes});return {id:record?id:null,versionId:null};}
      if(!record){record={id,channel:'cdp',header:null,headerStatus:'not-exposed',versions:[]};sheets.set(id,record);}
      const contentHash=hash(text),versionId=`${id}:${contentHash}`;
      let version=record.versions.find(v=>v.id===versionId);
      if(!version){version={id:versionId,contentHash,text,states:[]};record.versions.push(version);}
      if(stateId && !version.states.includes(stateId))version.states.push(stateId);
      return {id,versionId};
    }catch(error){
      if(!header)gap({kind:'stylesheet-header-unavailable',protocolStyleSheetId:styleSheetId,reason:String(error.message)});
      gap({kind:'stylesheet-text-unavailable',stylesheetId:record?id:null,protocolStyleSheetId:styleSheetId,reason:String(error.message)});
      return {id:record?id:null,versionId:null};
    }
  }

  async function fingerprint(snapshot) {
    const frames=[];
    for (const [index,frame] of page.frames().entries()) {
      try {
        const evidence=await frame.evaluate(readCssomEvidence,{maxRules});
        const annotate=(sheet,items)=>{for(const item of items){item.id=`cssom-rule:${hash({sheetId:sheet.id,path:item.path,cssText:item.cssText})}`;item.stylesheetId=sheet.id;if(item.children)annotate(sheet,item.children);}};
        for(const sheet of evidence.sheets)annotate(sheet,sheet.rules);
        frames.push({frameIndex:index,...evidence});
      }
      catch(error) {gap({kind:'cssom-frame-unavailable',frameIndex:index,reason:String(error.message)});}
    }
    const versions=[];
    for (const info of sessions.values()) for (const [id,header] of info.headers) if (header.active) versions.push(await sheetVersion(info,id));
    revision={frames,versions};
    // Ignore computed @media activity here: appearance/layout captures the actual state.
    return hash(frames.map(frame=>{
      const byId=new Map(frame.sheets.map(sheet=>[sheet.id,sheet]));
      function semanticSheet(id,seen=new Set()) {
        if(seen.has(id))return {cycle:true};
        const sheet=byId.get(id);if(!sheet)return {missing:true};
        const next=new Set([...seen,id]);
        const content=items=>items.map(item=>({cssText:item.cssText,imported:item.importedSheetId?semanticSheet(item.importedSheetId,next):null,children:item.children?content(item.children):null}));
        return {href:sheet.href,disabled:sheet.disabled,media:sheet.media,rules:content(sheet.rules)};
      }
      return {frameIndex:frame.frameIndex,scopes:frame.scopes.map((scope,index)=>({kind:scope.kind,
        host:snapshot?.nodes?.find(n=>n.elementId===scope.hostElementId)?.selector || (scope.kind==='document'?'document':`shadow-${index}`),
        styleSheets:scope.styleSheets.map(id=>semanticSheet(id)),adoptedStyleSheets:scope.adoptedStyleSheets.map(id=>semanticSheet(id))}))};
    }));
  }
  async function capture(snapshot,stateId) {
    if (!revision) await fingerprint(snapshot);
    const cssom=revision.frames;
    const state={id:`css:${stateId}`,stateId,stylesheetVersions:[],elements:[],frames:[],missing:[]};
    snapshots.push(state);
    for (const frame of cssom) {
      cssomSnapshots.push({stateId,...frame});
      for (const item of frame.missing) gap({stateId,frameIndex:frame.frameIndex,...item});
    }
    for (const [index,frame] of page.frames().entries()) {
      let info;
      try {info=await forFrame(frame,index);} catch(error) {gap({kind:'frame-context-unavailable',frameIndex:index,reason:String(error.message)});}
      if (!info) {state.missing.push({frameIndex:index,reason:'CDP context unavailable; see CSSOM and resource evidence'});continue;}
      const candidates=snapshot.nodes.filter(n=>n.frameIndex===index && !['head','style','script','link','meta','title'].includes(n.tagName));
      if (candidates.length>maxNodes) state.missing.push({frameIndex:index,reason:'matched-node-budget',eligible:candidates.length,captured:maxNodes});
      const nodes=candidates.slice(0,maxNodes), group=`wrk-css-${++captureSequence}`;
      const versionCache=new Map();
      async function normalizeRule(rule,kind='matched',owner=null) {
        const style=rule.style || {}, elementStyle=['inline','attributes'].includes(kind) || ['inline','attributes'].includes(rule.origin);
        if(elementStyle && !(style.cssProperties?.length || style.shorthandEntries?.length))return null;
        const styleSheetId=elementStyle?null:rule.styleSheetId || style.styleSheetId;
        let source={kind:rule.origin || kind,stylesheetId:null,versionId:null,url:null,range:rule.selectorList?.selectors?.[0]?.range || style.range || null,selectorRange:rule.selectorList?.selectors?.[0]?.range || null,declarationsRange:style.range || null};
        if (styleSheetId && !(rule.origin==='user-agent' && !info.headers.has(styleSheetId))) {
          if (!versionCache.has(styleSheetId)) versionCache.set(styleSheetId,await sheetVersion(info,styleSheetId,stateId));
          const version=versionCache.get(styleSheetId), sheet=sheets.get(version.id);
          source={...source,stylesheetId:version.id,versionId:version.versionId,url:sheet?.header?.sourceURL || null,headerRange:sheet?.header ? {startLine:sheet.header.startLine,startColumn:sheet.header.startColumn} : null};
        } else if (owner) source={...source,elementId:owner};
        const {styleSheetId:ignoredStyleSheetId,...normalizedStyle}=style;
        const id=`rule:${hash({source,selector:rule.selectorList?.text || null,style:normalizedStyle,media:rule.media,supports:rule.supports,containerQueries:rule.containerQueries,layers:rule.layers,scopes:rule.scopes})}`;
        if(!rules.has(id) && rules.size>=maxRules){if(!state.missing.some(m=>m.reason==='matched-rule-budget'))state.missing.push({reason:'matched-rule-budget',limit:maxRules});return null;}
        if(!rules.has(id)) {
          const declarations=style.cssProperties || [];
          const variableNames=[...new Set(declarations.filter(p=>p.name?.startsWith('--')).map(p=>p.name))];
          const references=new Map();
          for(const property of declarations)for(const match of String(property.value ?? '').matchAll(/var\(\s*(--[\w-]+)/g))references.set(`${property.name}|${match[1]}`,{property:property.name,name:match[1]});
          const {style:ignoredStyle,...protocol}=rule;
          rules.set(id,{id,selector:rule.selectorList?.text || null,source,declarations,variableNames,variableReferences:[...references.values()],protocol,styleMetadata:{range:style.range || null,shorthandEntries:style.shorthandEntries || []}});
        }
        return id;
      }
      async function normalizeMatches(matches,kind,owner) {
        const result=[];
        for (const [order,match] of (matches || []).entries()) result.push({ruleId:await normalizeRule(match.rule,kind,owner),matchingSelectors:match.matchingSelectors || [],protocolOrder:order});
        return result;
      }
      try {
        await info.session.send('DOM.getDocument',{depth:0,pierce:true});
        const evaluated=await info.session.send('Runtime.evaluate',{contextId:info.contextId,objectGroup:group,expression:`(${resolveElements.toString()})(${JSON.stringify(nodes.map(n=>n.selector))})`});
        if (!evaluated.result.objectId) throw new Error(evaluated.exceptionDetails?.text || 'DOM mapping did not return an array');
        const properties=await info.session.send('Runtime.getProperties',{objectId:evaluated.result.objectId,ownProperties:true});
        const handles=new Map(properties.result.filter(p=>/^\d+$/.test(p.name)).map(p=>[Number(p.name),p.value?.objectId]));
        // Bounded parallel reads; preserve source element and rule order in the output.
        for (let start=0;start<nodes.length;start+=12) {
          const batch=await Promise.all(nodes.slice(start,start+12).map(async(node,offset)=>{
            const objectId=handles.get(start+offset);
            if (!objectId) return {elementId:node.elementId,key:node.key,missing:'locator missing or ambiguous during CSS capture'};
            try {
              const {nodeId}=await info.session.send('DOM.requestNode',{objectId});
              const [matched,computed]=await Promise.all([info.session.send('CSS.getMatchedStylesForNode',{nodeId}),info.session.send('CSS.getComputedStyleForNode',{nodeId})]);
              const entry={elementId:node.elementId,key:node.key,selector:node.selector,frameIndex:index,nodeId,matchedRules:await normalizeMatches(matched.matchedCSSRules,'matched'),inherited:[],pseudoElements:[],computedStyle:Object.fromEntries(computed.computedStyle.map(p=>[p.name,p.value]))};
              if (matched.inlineStyle) entry.inlineRuleId=await normalizeRule({origin:'inline',style:matched.inlineStyle},'inline',node.elementId);
              if (matched.attributesStyle) entry.attributesRuleId=await normalizeRule({origin:'attributes',style:matched.attributesStyle},'attributes',node.elementId);
              for (const [ancestorLevel,inherited] of (matched.inherited || []).entries()) entry.inherited.push({ancestorLevel,matchedRules:await normalizeMatches(inherited.matchedCSSRules,'inherited'),inlineRuleId:inherited.inlineStyle ? await normalizeRule({origin:'inline',style:inherited.inlineStyle},'inherited',node.ancestorElementIds?.[ancestorLevel] || null):null});
              for (const pseudo of matched.pseudoElements || []) entry.pseudoElements.push({pseudoType:pseudo.pseudoType,pseudoIdentifier:pseudo.pseudoIdentifier || null,matchedRules:await normalizeMatches(pseudo.matches,'pseudo')});
              const ruleIds=new Set([...entry.matchedRules,...entry.inherited.flatMap(a=>a.matchedRules)].map(r=>r.ruleId));
              if(entry.inlineRuleId)ruleIds.add(entry.inlineRuleId);
              for(const ancestor of entry.inherited)if(ancestor.inlineRuleId)ruleIds.add(ancestor.inlineRuleId);
              const values=Object.fromEntries(Object.entries(entry.computedStyle).filter(([name])=>name.startsWith('--')).sort(([a],[b])=>a.localeCompare(b)));
              const resolvedSetId=`vars:${hash(values)}`;
              if(!resolvedVariableSets.has(resolvedSetId))resolvedVariableSets.set(resolvedSetId,{id:resolvedSetId,values});
              entry.computedStyle=Object.fromEntries(Object.entries(entry.computedStyle).filter(([name])=>!name.startsWith('--')));
              entry.resolvedVariableSetId=resolvedSetId;
              variableElements.push({stateId,elementId:node.elementId,frameIndex:index,scopeId:node.scopeId || null,resolvedSetId,
                sourceRuleIds:[...ruleIds].filter(id=>{const rule=rules.get(id);return rule && (rule.variableNames.length || rule.variableReferences.length);})});
              return entry;
            } catch(error) {return {elementId:node.elementId,key:node.key,selector:node.selector,frameIndex:index,missing:String(error.message)};}
          }));
          state.elements.push(...batch);
        }
        for (const [id,header] of info.headers) if (header.active) {
          if (!versionCache.has(id)) versionCache.set(id,await sheetVersion(info,id,stateId));
        }
        state.stylesheetVersions.push(...versionCache.values());
        const first=state.elements.find(n=>n.frameIndex===index && n.nodeId);
        if (first) {
          try {state.frames.push({frameIndex:index,frameId:info.frameId,layers:await info.session.send('CSS.getLayersForNode',{nodeId:first.nodeId})});}
          catch(error) {state.frames.push({frameIndex:index,frameId:info.frameId,layers:null,missingReason:String(error.message)});}
        }
      } catch(error) {state.missing.push({frameIndex:index,reason:String(error.message)});}
      finally {await info.session.send('Runtime.releaseObjectGroup',{objectGroup:group}).catch(()=>{});}
    }
    return {cssSnapshotId:state.id};
  }
  return {
    fingerprint,capture,
    export:()=>({schemaVersion:EVIDENCE_SCHEMA_VERSION,stylesheets:[...sheets.values()],cssomSnapshots,rules:[...rules.values()],snapshots,variables:{schemaVersion:EVIDENCE_SCHEMA_VERSION,resolvedSets:[...resolvedVariableSets.values()],elements:variableElements},missing,budgets:{maxNodes,maxRules,maxSheetBytes}}),
    dispose:async()=>{await Promise.all([...sessions.values()].map(s=>s.session.detach().catch(()=>{})));}
  };
}
