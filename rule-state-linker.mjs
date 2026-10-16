// Associate facts recorded by the browser. No component or behavior synthesis.
import { correspondElements } from './state-diff.mjs';

const ref = node => node ? {elementId:node.elementId || null,key:node.key,frameIndex:node.frameIndex || 0,scopeId:node.scopeId || null} : null;
const matchedIds = entry => [...new Set([...(entry?.matchedRules || []).map(r=>r.ruleId),entry?.inlineRuleId,entry?.attributesRuleId].filter(Boolean))];

export function linkRuleStates({states=[],transitions=[],observations=[],css={}}) {
  const byState=new Map(states.map(s=>[s.id,s]));
  const observed=new Map(observations.map(o=>[o.id,o]));
  const cssStates=new Map((css.snapshots || []).map(s=>[s.id,s]));
  const rules=new Map((css.rules || []).map(r=>[r.id,r]));
  const ruleRefs=ids=>ids.map(id=>({ruleId:id,source:rules.get(id)?.source || null}));
  const relations=transitions.map((transition,index)=>{
    const before=transition.beforeObservationId ? observed.get(transition.beforeObservationId) : byState.get(transition.from),after=transition.afterObservationId ? observed.get(transition.afterObservationId) : byState.get(transition.to);
    const base={transitionId:transition.id || `transition-${String(index).padStart(4,'0')}`,from:transition.from,to:transition.to,beforeObservationId:transition.beforeObservationId || null,afterObservationId:transition.afterObservationId || null,action:transition.action,controlId:transition.control.id};
    if(transition.evidenceMissing?.length)return {...base,status:'unresolved',reason:transition.evidenceMissing.join('; '),effects:transition.effects,targets:[]};
    if (!before || !after) return {...base,status:'unresolved',reason:'state absent or state budget exhausted',targets:[]};
    const a=before.snapshot,b=after.snapshot;
    const triggers=a.nodes.filter(n=>n.selector===transition.control.selector && (n.frameIndex || 0)===(transition.control.frameIndex || 0));
    const trigger=triggers.length===1 ? triggers[0]:null;
    const declared=[];
    if(trigger) for(const attribute of ['aria-controls','aria-describedby','aria-owns','popovertarget']) {
      for(const id of (trigger.attributes?.[attribute] || '').split(/\s+/).filter(Boolean)) {
        const candidates=a.nodes.filter(n=>n.attributes?.id===id && n.scopeId===trigger.scopeId && n.frameIndex===trigger.frameIndex);
        declared.push({attribute,authorId:id,target:candidates.length===1?ref(candidates[0]):null,status:candidates.length===1?'declared':'unresolved',reason:candidates.length===1?null:'referenced target missing or ambiguous in source root'});
      }
    }
    const correspondences=correspondElements(a,b);
    const left=cssStates.get(before.evidence?.cssSnapshotId),right=cssStates.get(after.evidence?.cssSnapshotId);
    const targets=[];
    for(const pair of correspondences) {
      const old=pair.before,node=pair.after || old;
      const effects=transition.effects.filter(e=>e.elementId ? e.elementId===node.elementId || e.elementId===old?.elementId : e.key===node.key || e.key===old?.key);
      if (!effects.length) continue;
      const prior=left?.elements.find(e=>e.elementId===old?.elementId),next=right?.elements.find(e=>e.elementId===pair.after?.elementId);
      const beforeIds=matchedIds(prior),afterIds=matchedIds(next);
      const removed=beforeIds.filter(id=>!afterIds.includes(id)),added=afterIds.filter(id=>!beforeIds.includes(id));
      const stateChanges=effects.filter(e=>['attribute','property','aria','value','text','content','visibility','insert','remove','move','children'].includes(e.type));
      const sameTrigger=trigger && (node.elementId===trigger.elementId || old?.elementId===trigger.elementId);
      const declaration=declared.find(d=>d.target && [node.elementId,old?.elementId].includes(d.target.elementId));
      // Exact attribute selectors on this node are evidence of a selector dependency.
      // Complex selectors can depend on ancestors/siblings; do not assign causality to them.
      const dependencies=[];
      for(const id of [...removed,...added]) {
        const rule=rules.get(id), selector=rule?.selector;
        if(!selector || !old || !pair.after) continue;
        const names=stateChanges.filter(e=>e.type==='attribute').map(e=>e.name);
        if(/:(?:has|is|not|where)\(/.test(selector) || /[\s>+~,]/.test(selector.replace(/\[[^\]]*\]/g,''))) continue;
        for(const name of names) {
          const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
          if(new RegExp(`\\[\\s*${escaped}(?:\\s|[~|^$*]?=|\\])`,'i').test(selector)) dependencies.push({ruleId:id,attribute:name,basis:'changed own attribute occurs in an actually matched simple selector'});
          if(name==='class' && selector.includes('.')) dependencies.push({ruleId:id,attribute:name,basis:'class changed and matched simple selector changed',causality:'unresolved'});
        }
      }
      const linked=Boolean(trigger && (sameTrigger || declaration) && old && pair.after && prior && next && !prior.missing && !next.missing);
      targets.push({before:ref(old),after:ref(pair.after),correspondence:pair.basis,physicalIdentity:pair.physicalIdentity,
        status:linked?'observed':'unresolved',basis:linked?(sameTrigger?'action target':'explicit '+declaration.attribute):null,
        reason:linked?null:!old || !pair.after?'node inserted or removed; no cross-state identity':!trigger?'trigger unresolved':!prior || !next || prior.missing || next.missing?'matched CSS evidence unavailable':'no declared trigger/target relation',
        stateChanges,effects,matchedRules:{before:ruleRefs(beforeIds),after:ruleRefs(afterIds),added:ruleRefs(added),removed:ruleRefs(removed)},selectorDependencies:dependencies,
        causality:dependencies.some(d=>!d.causality)?'selector-dependency-observed':'unresolved'});
    }
    return {...base,trigger:ref(trigger),declaredTargets:declared,status:trigger && targets.some(t=>t.status==='observed')?'observed':'unresolved',
      reason:trigger?targets.length?null:'no element change observed':'trigger missing or ambiguous',targets};
  });
  return {schemaVersion:1,policy:'observed facts and declared DOM relations; causal behavior is not inferred',relations};
}
