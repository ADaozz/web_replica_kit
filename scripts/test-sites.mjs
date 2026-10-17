// Explicit fixed integration cases only. Never follows discovery results.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';
import {auditSnapshot} from './audit-snapshot.mjs';
const exec=promisify(execFile);
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=path.resolve(option('--out','test-results/sites-'+Date.now()));
const only=option('--only','').split(',').filter(Boolean);
const matrix=JSON.parse(await fs.readFile(new URL('../tests/site-matrix.json',import.meta.url)));
const sites=matrix.filter(s=>!only.length||only.includes(s.id));if(!sites.length)throw new Error('No matching sites');
await fs.mkdir(out,{recursive:true});
async function cli(name,url,directory){
 try {const {stdout}=await exec(process.execPath,[`scripts/${name}.mjs`,'--url',url,'--out',directory,'--wait','1500'],{timeout:150000,maxBuffer:4*1024*1024});return {...JSON.parse(stdout),exitCode:0};}
 catch(error){if(error.code===2)return {...JSON.parse(error.stdout),exitCode:2};throw error;}
}
const report={date:new Date().toISOString(),viewport:{width:1440,height:900},cases:[],notes:['Fixed public URLs are explicitly selected test targets. Discovered URLs are never visited.','Pixel differences include live animations, video, canvas, timing and unavailable remote resources; they require review, not automatic acceptance.','Output artifacts are local test evidence and are not published.']};
const browser=await chromium.launch();
try {
 for(const site of sites){
  const result={id:site.id,url:site.url};report.cases.push(result);let stage='discover';
  console.error('Testing',site.id);
  try {
   const discovery=path.join(out,site.id+'-discovery');result.discovery=await cli('discover',site.url,discovery);
   const navigation=JSON.parse(await fs.readFile(path.join(discovery,'navigation.json')));result.navigationEntries=navigation.entries.length;
   stage='capture';const directory=path.join(out,site.id);result.capture=await cli('capture',site.url,directory);
   result.report=JSON.parse(await fs.readFile(path.join(directory,'report.json')));
   stage='preview';result.audit=await auditSnapshot(directory);
   const page=await browser.newPage({viewport:report.viewport});const failed=[];
   try {
    page.on('requestfailed',r=>failed.push({url:r.url(),reason:r.failure()?.errorText}));
    await page.route(/^https?:/,route=>route.abort());
    await page.goto(pathToFileURL(path.join(directory,'index.html')).href,{waitUntil:'load',timeout:30000});await page.waitForTimeout(300);
    const bytes=await page.screenshot();await fs.writeFile(path.join(directory,'preview.png'),bytes);
    const a=PNG.sync.read(await fs.readFile(path.join(directory,'screenshot.png'))),b=PNG.sync.read(bytes);
    result.pixelDiffRatio=pixelmatch(a.data,b.data,null,a.width,a.height,{threshold:0.1})/(a.width*a.height);result.previewFailedRequests=failed;
    result.status='measured';
   }finally{await page.close();}
   async function size(dir){let bytes=0;for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);bytes+=entry.isDirectory()?await size(file):(await fs.stat(file)).size;}return bytes;}
   result.outputBytes=await size(directory);
  }catch(error){result.status='failed';result.stage=stage;result.error=String(error.stderr || error.message).slice(0,3000);result.classification=/ERR_|Timeout|HTTP 4|HTTP 5|certificate/i.test(result.error)?'external-access-or-load-failure':'requires-investigation';}
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2));
 }
}finally{await browser.close();}
console.log(JSON.stringify({output:out,cases:report.cases.map(c=>({id:c.id,status:c.status,stage:c.stage,pixelDiffRatio:c.pixelDiffRatio}))}));
