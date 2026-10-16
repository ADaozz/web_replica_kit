import path from 'node:path';
import {createHash} from 'node:crypto';
import {EVIDENCE_SCHEMA_VERSION} from './evidence-schema.mjs';
import {writeJsonFile} from './json-writer.mjs';
const filename=id=>createHash('sha256').update(id).digest('hex').slice(0,24)+'.json';

// Large per-observation records live in individual JSON files; manifests keep IDs.
export async function writeCssEvidence(root,evidence,resourceFiles=[]) {
  const write=(file,data)=>writeJsonFile(path.join(root,file),data);
  const snapshots=[];
  for(const snapshot of evidence.snapshots) {
    const file='css/states/'+filename(snapshot.id);
    await write(file,{schemaVersion:EVIDENCE_SCHEMA_VERSION,...snapshot});
    snapshots.push({id:snapshot.id,stateId:snapshot.stateId,file});
  }
  const cssomSnapshots=[];
  for(const snapshot of evidence.cssomSnapshots) {
    const file='css/cssom/'+filename(`${snapshot.stateId}|${snapshot.frameIndex}`);
    await write(file,{schemaVersion:EVIDENCE_SCHEMA_VERSION,...snapshot});
    cssomSnapshots.push({stateId:snapshot.stateId,frameIndex:snapshot.frameIndex,documentId:snapshot.documentId,file});
  }
  const variableStates=new Map();
  for(const element of evidence.variables.elements) {
    if(!variableStates.has(element.stateId))variableStates.set(element.stateId,[]);
    variableStates.get(element.stateId).push(element);
  }
  const states=[];
  for(const [stateId,elements] of variableStates) {
    const file='css/variables/'+filename(stateId);
    await write(file,{schemaVersion:EVIDENCE_SCHEMA_VERSION,stateId,elements});
    states.push({stateId,file,elements:elements.length});
  }
  await write('css/stylesheets.json',{schemaVersion:EVIDENCE_SCHEMA_VERSION,stylesheets:evidence.stylesheets,resourceFiles,cssomSnapshots,missing:evidence.missing,budgets:evidence.budgets});
  await write('css/matched-rules.json',{schemaVersion:EVIDENCE_SCHEMA_VERSION,rules:evidence.rules,snapshots});
  await write('css/variables.json',{schemaVersion:EVIDENCE_SCHEMA_VERSION,resolvedSets:evidence.variables.resolvedSets,states});
}
