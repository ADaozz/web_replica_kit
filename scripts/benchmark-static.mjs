// Optional same-machine baseline comparison. Never loads extra pages.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),args=process.argv.slice(2),option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const baseline=option('--baseline',null);if(!baseline)throw new Error('--baseline must name a checkout of the previous version');
const out=path.resolve(option('--out','test-results/benchmark-'+Date.now()));await fs.mkdir(out,{recursive:true});
const fixture=await fs.readFile(new URL('../tests/fixtures/css-repros/ISSUE-001/page-800.html',import.meta.url));
const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=option('--url',`http://127.0.0.1:${server.address().port}/`),timeout=Number(option('--timeout','180000'));
const runs=[];
const ticksPerSecond=Number((await exec('getconf',['CLK_TCK'])).stdout.trim());
async function measure(name,cwd,cli){
 const directory=path.join(out,name),started=performance.now();
 const child=spawn(process.execPath,[cli,'--url',url,'--out',directory,'--width','1440','--height','900','--wait','1500','--max-nodes','5000'],{cwd,detached:true});
 let stdout='',stderr='',nodePeak=0,chromiumPeak=0,sampling=false,timedOut=false;
 child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const cpuTicks=new Map();
 const sample=async()=>{if(sampling)return;sampling=true;try{
  const {stdout}=await exec('ps',['-eo','pid=,ppid=,rss=,comm=']);const rows=stdout.trim().split('\n').map(r=>r.trim().split(/\s+/));const descendants=new Set([String(child.pid)]);let changed=true;
  while(changed){changed=false;for(const [pid,ppid] of rows)if(descendants.has(ppid)&&!descendants.has(pid)){descendants.add(pid);changed=true;}}
  let node=0,chrome=0;for(const [pid,,rss,comm] of rows)if(descendants.has(pid)){
    try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');cpuTicks.set(pid,Number(fields[11])+Number(fields[12]));}catch{}if(pid===String(child.pid)||/node|MainThread/.test(comm))node+=Number(rss)*1024;else if(/chrome|chromium/.test(comm))chrome+=Number(rss)*1024;}
  nodePeak=Math.max(nodePeak,node);chromiumPeak=Math.max(chromiumPeak,chrome);
 }catch{}finally{sampling=false;}};
 const interval=setInterval(sample,200),kill=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}},timeout);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearInterval(interval);clearTimeout(kill);
 async function size(dir){let n=0;for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const f=path.join(dir,e.name);n+=e.isDirectory()?await size(f):(await fs.stat(f)).size;}return n;}
 const result={name,url,exitCode:code,timedOut,wallMs:performance.now()-started,sampledProcessTreeCpuMs:[...cpuTicks.values()].reduce((a,b)=>a+b,0)/ticksPerSecond*1000,nodePeakSampledBytes:nodePeak,chromiumPeakSampledRssSumBytes:chromiumPeak,outputBytes:await size(directory),report:await fs.readFile(path.join(directory,'report.json'),'utf8').then(JSON.parse).catch(()=>null),stderr:stderr.slice(-1500)};
 runs.push(result);await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({viewport:{width:1440,height:900},maxNodes:5000,runs,notes:['CPU counters and memory sampled every 200ms; short-lived processes and the final sampling interval may be missed. Memory is RSS; Chromium RSS sums include shared pages, not unique physical memory.','Old implementation automatically scrolls during loading; dynamic/lazy page state may therefore differ. Static synthetic fixture avoids this confound.','Timeout is a censored measurement, not a successful baseline.']},null,2));
 console.log(JSON.stringify({name,wallMs:result.wallMs,exitCode:code,timedOut}));
}
try{await measure('static',path.resolve(import.meta.dirname,'..'),'scripts/capture.mjs');await measure('baseline',path.resolve(baseline),'capture.mjs');}finally{await new Promise(r=>server.close(r));}
