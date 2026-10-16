import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvidenceManifest} from '../evidence-output.mjs';

test('manifest connects stable DOM trees, per-state documents, CSS snapshots and controls',()=>{
  const snapshot={observationId:'o0',route:'/app',frames:[{index:0,documentId:'doc'}],nodes:[{elementId:'host',scopeId:'doc:document',selector:'#host',frameIndex:0,parentElementId:null,childElementIds:[],shadowChildElementIds:['inside']},{elementId:'inside',scopeId:'host:shadow',selector:'#host >>> #inside',frameIndex:0,parentElementId:'host',childElementIds:[]}]};
  const evidence={cssSnapshotId:'css:o0'};
  const manifest=buildEvidenceManifest({states:[{id:'s0',hash:'hash',snapshot,evidence}],observations:[{id:'o0',snapshot,evidence}],controls:[{id:'inside-control',selector:'#host >>> #inside'}]});
  assert.equal(manifest.states[0].domRef,'dom/states/o0.json');assert.equal(manifest.states[0].cssRef.snapshotId,'css:o0');
  assert.equal('snapshot' in manifest.states[0],false);assert.deepEqual(manifest.tree.frames[0].roots,['host']);
  assert.deepEqual(manifest.tree.nodes[0].shadowChildren,['inside']);assert.equal(manifest.controls[0].elementRefs[0].elementId,'inside');
  assert.equal(manifest.documents[0].snapshot,snapshot);
});

test('observation budget exhaustion retains canonical DOM and an explicit missing CSS reference',()=>{
  const initial={observationId:'o0',nodes:[],frames:[]},limited={nodes:[],frames:[],missingCssReason:'observation evidence budget exhausted'};
  const manifest=buildEvidenceManifest({states:[{id:'s0',snapshot:initial,evidence:{cssSnapshotId:'css:o0'}},{id:'s1',snapshot:limited,evidence:{cssSnapshotId:null}}],observations:[{id:'o0',snapshot:initial,evidence:{cssSnapshotId:'css:o0'}}],controls:[]});
  assert.equal(manifest.states[1].domRef,'dom/states/s1-dom-only.json');assert.equal(manifest.states[1].cssRef,null);
  assert.equal(manifest.observations[1].missing,'observation evidence budget exhausted');assert.equal(manifest.documents[1].snapshot,limited);
});
