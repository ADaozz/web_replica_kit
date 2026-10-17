// Recheck saved evidence without revisiting any remote page or changing captures.
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {verifyPreviews} from './site-verification.mjs';
const [outArg,...summaries]=process.argv.slice(2);if(!outArg||!summaries.length)throw new Error('Usage: node scripts/review-previews.mjs FRESH_OUTPUT SUMMARY_JSON...');
const out=path.resolve(outArg);await fs.mkdir(out,{recursive:true});if((await fs.readdir(out)).length)throw new Error('Output directory must be empty');
const report={date:new Date().toISOString(),previewWaitMs:3000,notes:['All saved successful captures are reviewed at the same 3000ms settle period after fonts.ready. Original captures are unchanged. No remote pages are visited.','Baseline source screenshots include live video/canvas/animation frames; residual differences are measured, not masked.'],cases:[]};const browser=await chromium.launch();
try{for(const file of summaries){const original=JSON.parse(await fs.readFile(file));for(const c of original.cases){if(c.status!=='measured')continue;const result={id:c.id,sourceSummary:path.resolve(file),sourceDirectory:c.capture.output,initialPixelDiffRatio:c.pixelDiffRatio};report.cases.push(result);
try{result.previews=await verifyPreviews({browser,directory:c.capture.output,viewport:original.viewport,sourceUrl:c.report.finalUrl,waitMs:3000,outputDirectory:path.join(out,c.id)});result.status='measured';}catch(error){result.status='failed';result.error=error.message.split('\n')[0];}
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2));console.error(c.id,result.status,result.previews?.map(p=>(p.pixelDiffRatio*100).toFixed(3)+'%').join('/'));}}}finally{await browser.close();}
console.log(JSON.stringify({output:out,measured:report.cases.filter(c=>c.status==='measured').length}));
