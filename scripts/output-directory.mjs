import fs from 'node:fs/promises';
import path from 'node:path';
// Reserve an empty directory so simultaneous commands cannot mix captures.
export async function reserveOutput(directory) {
  await fs.mkdir(directory,{recursive:true});
  const lock=path.join(directory,'.web-replica.lock');
  const handle=await fs.open(lock,'wx').catch(error=>{if(error.code==='EEXIST')throw new Error('Output directory is reserved by another operation');throw error;});
  await handle.close();
  const release=()=>fs.unlink(lock);
  try {
    if((await fs.readdir(directory)).some(name=>name!=='.web-replica.lock'))throw new Error('Output directory must be empty');
    return release;
  }catch(error){await release();throw error;}
}
