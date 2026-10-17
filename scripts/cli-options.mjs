import path from 'node:path';
export function parseArgs(argv) {
  const values = {};
  const flags = new Set(['headed','headless']);
  const supported = new Set(['url','out','width','height','wait','ready-selector','ready-timeout','max-nodes','executable',...flags]);
  for(let i=0;i<argv.length;i++) {
    const key=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--') || !supported.has(key)) throw new Error(`Unknown option: ${argv[i]}`);
    if(key in values)throw new Error(`Duplicate option: --${key}`);
    if(flags.has(key)){values[key]=true;continue;}
    if(!argv[i+1] || argv[i+1].startsWith('--'))throw new Error(`Missing value: --${key}`);
    values[key]=argv[++i];
  }
  if(!values.url)throw new Error('--url is required');
  const url=new URL(values.url);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw new Error('A credential-free HTTP(S) URL is required');
  if(values.headed && values.headless)throw new Error('--headed and --headless conflict');
  const number=(key,fallback,min,max)=>{
    const n=values[key]===undefined?fallback:Number(values[key]);
    if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid --${key}: expected ${min}..${max}`);
    return n;
  };
  return {url:url.href,out:path.resolve(values.out || 'output'),width:number('width',1440,1,3840),height:number('height',900,1,2160),wait:number('wait',1500,0,30000),maxNodes:number('max-nodes',5000,1,20000),readyTimeout:number('ready-timeout',30000,1,300000),readySelector:values['ready-selector'],headed:!!values.headed,executablePath:values.executable};
}
