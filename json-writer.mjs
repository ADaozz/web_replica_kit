import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Yield compact JSON without creating a string proportional to the whole document.
// Even individual stylesheet strings are escaped in bounded pieces.
export function* jsonChunks(input,{stringChunkSize=8192}={}) {
  if(!Number.isInteger(stringChunkSize) || stringChunkSize<1)throw new RangeError('positive stringChunkSize required');
  const ancestors=new Set();
  function* string(value) {
    yield '"';
    for(let offset=0;offset<value.length;) {
      let end=Math.min(value.length,offset+stringChunkSize);
      if(end<value.length && value.charCodeAt(end-1)>=0xd800 && value.charCodeAt(end-1)<=0xdbff && value.charCodeAt(end)>=0xdc00 && value.charCodeAt(end)<=0xdfff)end++;
      yield JSON.stringify(value.slice(offset,end)).slice(1,-1);offset=end;
    }
    yield '"';
  }
  const prepare=(value,key)=>value && typeof value.toJSON==='function'?value.toJSON(key):value;
  const omitted=value=>value===undefined || typeof value==='function' || typeof value==='symbol';
  function* encode(value) {
    if(typeof value==='string'){yield* string(value);return;}
    if(value===null || typeof value!=='object') {yield JSON.stringify(value) ?? 'null';return;}
    if(ancestors.has(value))throw new TypeError('Converting circular structure to JSON');
    ancestors.add(value);
    if(Array.isArray(value)) {
      yield '[';
      for(let index=0;index<value.length;index++){if(index)yield ',';yield* encode(prepare(value[index],String(index)));}
      yield ']';
    } else {
      yield '{';let first=true;
      for(const key of Object.keys(value)) {
        const child=prepare(value[key],key);if(omitted(child))continue;
        if(!first)yield ',';first=false;yield* string(key);yield ':';yield* encode(child);
      }
      yield '}';
    }
    ancestors.delete(value);
  }
  yield* encode(prepare(input,''));
}

export async function writeJsonFile(file,value,{batchBytes=64*1024,...options}={}) {
  if(!Number.isInteger(batchBytes) || batchBytes<1)throw new RangeError('positive batchBytes required');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=`${file}.${randomUUID()}.partial`,buffer=Buffer.allocUnsafe(batchBytes);
  let handle,used=0,bytes=0,batches=0;
  try {
    handle=await fs.open(temporary,'wx');
    const flush=async()=>{if(used){await handle.writeFile(buffer.subarray(0,used));bytes+=used;batches++;used=0;}};
    for(const chunk of jsonChunks(value,options)) {
      const encoded=Buffer.from(chunk);
      for(let offset=0;offset<encoded.length;) {
        const count=Math.min(batchBytes-used,encoded.length-offset);encoded.copy(buffer,used,offset,offset+count);used+=count;offset+=count;
        if(used===batchBytes)await flush();
      }
    }
    await flush();await handle.close();handle=null;await fs.rename(temporary,file);
    return {bytes,batches,batchBytes};
  } finally {await handle?.close();await fs.rm(temporary,{force:true});}
}
