import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditSnapshot } from '../scripts/audit-snapshot.mjs';

async function writeHtml(out,body){await fs.writeFile(path.join(out,'index.html'),'<html><head></head><body>'+body+'</body></html>');}

test('complex static audit separates saved-but-remote sprites, missing symbols and missing CSS resources', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-audit-'));
  try {
    await fs.mkdir(path.join(out, 'assets'));
    await fs.writeFile(path.join(out, 'assets/sprite.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="search"/></svg>');
    await fs.writeFile(path.join(out, 'assets/icons.css'),
      '.a{mask:url("./sprite.svg#search")} .b{background:url(./missing.png)} .c{background:url(https://example.test/remote.svg)}');
    await writeHtml(out, `<!doctype html><svg>
<defs><path id="inline"/></defs><use href="#inline"/>
<use href="#missing"/><use href="assets/sprite.svg#search"/>
<use xlink:href="assets/sprite.svg#absent"/>
<use href="https://example.test/sprite.svg#search"/></svg>`);
    await fs.writeFile(path.join(out, 'assets.json'), JSON.stringify({schemaVersion:3,resources:[
      { url: 'https://example.test/sprite.svg', localPath: 'assets/sprite.svg' },
      { url: 'https://example.test/icons.css', localPath: 'assets/icons.css' }
    ]}));
    const audit = await auditSnapshot(out);
    assert.equal(audit.visualVerification, false);
    assert.equal(audit.stats.svgUses, 5);
    assert.equal(audit.stats.localSvgUses, 2);
    assert.equal(audit.stats.remoteSvgUses, 1);
    assert.equal(audit.stats.repairableSvgUses, 1);
    assert.equal(audit.stats.missingSvgIds, 2);
    assert.equal(audit.stats.missingFiles, 1);
    assert.equal(audit.stats.cssReferences, 3);
    assert.deepEqual(audit.issues.map(i => i.kind), [
      'missing-inline-svg-id', 'missing-external-svg-id', 'remote-svg-use',
      'missing-css-resource', 'remote-css-resource'
    ]);
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});

test('a clean static audit still does not imply browser or visual verification', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-clean-'));
  try {
    await writeHtml(out, '<svg><path id="icon"/><use href="#icon"/></svg>');
    await fs.writeFile(path.join(out, 'assets.json'), '{"schemaVersion":3,"resources":[]}');
    const audit = await auditSnapshot(out);
    assert.equal(audit.issueCount, 0);
    assert.equal(audit.visualVerification, false);
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});

test('inactive nested templates neither report missing sprites nor define active IDs', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-template-'));
  try {
    await writeHtml(out, `<template><svg><use href="/missing.svg#icon"/>
<path id="inactive"/></svg><template><svg><use href="#absent"/></svg></template></template>
<svg><use href="#inactive"/><path id="real"/><use href="#real"/></svg>`);
    await fs.writeFile(path.join(out, 'assets.json'), '{"schemaVersion":3,"resources":[]}');
    const audit = await auditSnapshot(out);
    assert.equal(audit.stats.excludedTemplateSvgUses, 2);
    assert.equal(audit.stats.svgUses, 2);
    assert.equal(audit.stats.missingFiles, 0);
    assert.deepEqual(audit.issues, [{ kind: 'missing-inline-svg-id', reference: '#inactive' }]);
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});
