/** Synthetic crash fixture: no env configuration, real chat or provider. */
import { SqliteExtractionLab } from '../../src/modules/memory-next/extraction-journal.js';
import { IsolatedMemoryExtractor } from '../../src/modules/memory-next/extraction-service.js';
const journal=SqliteExtractionLab.open(process.argv[2]);
const context={actorId:'yan',conversationId:'A',audience:'private' as const};
const source={eventId:'m1:v1',text:'I like green tea',source:{id:'m1',version:'1',context:'real' as const,scope:{type:'private' as const,actors:['yan','owner']},active:true,deleted:false,occurredAt:'2026-10-18T00:00:00Z'}};
const service=new IsolatedMemoryExtractor({resolve:(conversationId,actorId)=>({conversationId,actorId,status:'allowed',grantRevision:'1'})},
 {readCurrent:()=>({conversationId:'A',audience:'private',privateOwnerId:'owner',sources:[source]})},
 {version:'fake-v1',async extract(){process.exit(71);}},undefined,{}, {stateStore:journal});
await service.extract(context,'interrupted');
throw Error('crash fixture must not reach this point');
