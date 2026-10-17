// Explicit fixed integration cases only. Never follows discovery results.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';
import {auditSnapshot} from './audit-snapshot.mjs';
import {classifyFailure,verifyStructure,verifyPreviews} from './site-verification.mjs';
const exec=promisify(execFile);
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=path.resolve(option('--out','test-results/sites-'+Date.now()));
const only=option('--only','').split(',').filter(Boolean);
const matrixPath=path.resolve(option('--matrix','tests/site-matrix.json'));
const wait=Number(option('--wait','1500')),maxNodes=Number(option('--max-nodes','5000')),timeout=Number(option('--timeout','150000')),previewWait=Number(option('--preview-wait',String(Math.max(300,wait))));
if(!Number.isInteger(previewWait)||previewWait<0||previewWait>30000||!Number.isInteger(wait)||wait<0||wait>30000||!Number.isInteger(maxNodes)||maxNodes<1||maxNodes>20000||!Number.isInteger(timeout)||timeout<1000)throw new Error('Invalid wait, max-nodes or timeout budget');
const sites=JSON.parse(await fs.readFile(matrixPath)).filter(s=>!only.length||only.includes(s.id));if(!sites.length)throw new Error('No matching sites');
await fs.mkdir(out,{recursive:true});if((await fs.readdir(out)).length)throw new Error('Test output directory must be empty');
async function cli(name,url,directory){
 const started=performance.now();
 try {const {stdout}=await exec(process.execPath,[`scripts/${name}.mjs`,'--url',url,'--out',directory,'--wait',String(wait),'--max-nodes',String(maxNodes)],{timeout,maxBuffer:4*1024*1024});return {...JSON.parse(stdout),exitCode:0,wallMs:performance.now()-started};}
 catch(error){if(error.code===2)return {...JSON.parse(error.stdout),exitCode:2,wallMs:performance.now()-started};throw error;}
}
const report={date:new Date().toISOString(),matrix:matrixPath,viewport:{width:1440,height:900},waitMs:wait,previewWaitMs:previewWait,maxNodes,timeoutMs:timeout,cases:[],notes:['Fixed public URLs are explicitly selected test targets. Discovered URLs are never visited. Discover and capture are attempted independently.','Source screenshots and evidence reflect documented noise cleanup. Capturing a gate or loading screen is not proof of capturing the requested product.','Pixel differences include animation, video, canvas, timing and unavailable remote resources; differences require review, not automatic acceptance.','File and HTTP previews block external network access. Artifacts stay local and are not published.']};
const save=()=>fs.writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2));
const browser=await chromium.launch();
try {
 for(const site of sites){
  const result={id:site.id,url:site.url,coverage:site.coverage};report.cases.push(result);
  console.error('Testing',site.id);
  try {
   const discovery=path.join(out,site.id+'-discovery');result.discovery=await cli('discover',site.url,discovery);
   result.navigationEntries=JSON.parse(await fs.readFile(path.join(discovery,'navigation.json'))).entries.length;
  }catch(error){result.discovery={status:'failed',...classifyFailure(error,'discover')};}
  await save();let stage='capture';
  try {
   const directory=path.join(out,site.id);result.capture=await cli('capture',site.url,directory);
   const read=name=>fs.readFile(path.join(directory,name),'utf8').then(JSON.parse);
   const [components,layout,computed,assets,captureReport]=await Promise.all(['components.json','layout.json','styles/computed.json','assets.json','report.json'].map(read));
   result.report=captureReport;result.structure=verifyStructure({components,layout,computed,assets,report:captureReport});
   stage='preview';result.audit=await auditSnapshot(directory);if(!result.audit.validPreview)throw new Error('Invalid generated HTML document');
   result.previews=await verifyPreviews({browser,directory,viewport:report.viewport,sourceUrl:captureReport.finalUrl,waitMs:previewWait});
   result.pixelDiffRatio=result.previews[0].pixelDiffRatio;result.previewFailedRequests=result.previews[0].failedRequests;
   result.status='measured';
   async function size(dir){let bytes=0;for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);bytes+=entry.isDirectory()?await size(file):(await fs.stat(file)).size;}return bytes;}
   result.outputBytes=await size(directory);
  }catch(error){result.status='failed';result.stage=stage;Object.assign(result,classifyFailure(error,stage));}
  await save();console.error(site.id,result.status,result.capture?.status || '-',result.pixelDiffRatio===undefined?'':(result.pixelDiffRatio*100).toFixed(3)+'%');
 }
}finally{await browser.close();}
console.log(JSON.stringify({output:out,cases:report.cases.map(c=>({id:c.id,status:c.status,capture:c.capture?.status,stage:c.stage,pixelDiffRatio:c.pixelDiffRatio}))}));
