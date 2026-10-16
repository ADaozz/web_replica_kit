// Data manifest only; paths are relative to the capture output directory.
export function buildDomTree(snapshot) {
  const known=new Set(snapshot.nodes.map(n=>n.elementId));
  return {schemaVersion:1,frames:snapshot.frames.map(frame=>({index:frame.index,documentId:frame.documentId || null,
    roots:snapshot.nodes.filter(n=>n.frameIndex===frame.index && !known.has(n.parentElementId)).map(n=>n.elementId)})),
    nodes:snapshot.nodes.map(n=>({elementId:n.elementId,parentElementId:n.parentElementId,
      children:(n.childElementIds || []).filter(id=>known.has(id)),shadowChildren:(n.shadowChildElementIds || []).filter(id=>known.has(id))}))};
}

export function buildEvidenceManifest(exploration) {
  const observed=exploration.observations?.length ? [...exploration.observations] : exploration.states.map((state,index)=>({id:`observation-${String(index).padStart(4,'0')}`,snapshot:state.snapshot,evidence:state.evidence}));
  for(const state of exploration.states)if(!observed.some(o=>o.id===state.snapshot.observationId || o.snapshot===state.snapshot))observed.push({id:`${state.id}-dom-only`,snapshot:state.snapshot,evidence:state.evidence});
  const references=new Map(observed.map(item=>[item.id,{id:item.id,domRef:`dom/states/${item.id}.json`,cssRef:item.evidence?.cssSnapshotId ? {file:'css/matched-rules.json',snapshotId:item.evidence.cssSnapshotId}:null,
    page:{origin:item.snapshot.origin,route:item.snapshot.route,historyState:item.snapshot.historyState,focus:item.snapshot.focus,frames:item.snapshot.frames},missing:item.snapshot.missingCssReason || null}]));
  const states=exploration.states.map(state=>{
    const observationId=observed.find(o=>o.id===state.snapshot.observationId || o.snapshot===state.snapshot)?.id;
    const observation=references.get(observationId);
    return {id:state.id,hash:state.hash,depth:state.depth,path:state.path,route:state.snapshot.route,
      observationId,domRef:observation?.domRef || null,cssRef:observation?.cssRef || null,page:observation?.page || null};
  });
  const controls=exploration.controls.map(control=>({...control,elementRefs:observed.flatMap(observation=>observation.snapshot.nodes
    .filter(node=>node.selector===control.selector && node.frameIndex===(control.frameIndex || 0) && (!control.frameUrl || observation.snapshot.frames[node.frameIndex]?.url===control.frameUrl))
    .map(node=>({observationId:observation.id,elementId:node.elementId,scopeId:node.scopeId})))}));
  return {schemaVersion:1,states,controls,observations:[...references.values()],documents:observed.map(o=>({file:references.get(o.id).domRef,snapshot:o.snapshot})),tree:buildDomTree(exploration.states[0].snapshot)};
}
