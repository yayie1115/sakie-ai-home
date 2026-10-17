/** Atomic local test snapshot adapter; NOT production SQLite or cross-device sync. */
import { mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryPipeline, type Snapshot } from './pipeline.js';
export async function saveSnapshot(path:string, pipeline:MemoryPipeline):Promise<void>{
  const dir=dirname(path);await mkdir(dir,{recursive:true,mode:0o700});
  const temp=join(dir,`.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp,JSON.stringify(pipeline.snapshot()),{flag:'wx',mode:0o600});
    const file=await open(temp,'r');try{await file.sync();}finally{await file.close();}
    await rename(temp,path);
  } finally {await rm(temp,{force:true});}
}
export async function loadSnapshot(path:string):Promise<MemoryPipeline>{
  const raw=await readFile(path,'utf8');
  return MemoryPipeline.fromSnapshot(JSON.parse(raw) as Snapshot);
}
