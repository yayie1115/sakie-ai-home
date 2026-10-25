import { createApp } from './app.js';
import { config } from './config/env.js';
import { openDatabase } from './database/index.js';
import { prepareStorage } from './storage/prepare.js';
async function main(){
  await prepareStorage(config);
  const db=openDatabase(config.databasePath);
  const app=createApp(db);
  const server=app.listen(config.port,config.host,()=>{app.locals.chat.start();app.locals.memory.start();console.log('API listening on http://'+config.host+':'+config.port);});
  server.on('error',error=>{console.error(error);db.close();process.exit(1);});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.close(()=>{void Promise.all([app.locals.chat.stop(),app.locals.memory.stop()]).then(()=>{db.close();process.exit(0);});});setTimeout(()=>process.exit(1),10000).unref();});
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
