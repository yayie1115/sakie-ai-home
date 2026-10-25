import type {ChatMessage} from '@sakie/contracts';
import {batchReady} from './live-batch.js';
import type { ChatConfig } from './config.js';
import type { ModelMessage } from './provider.js';
import { ChatStore } from './store.js';
/** Reads a bounded number of complete turns. Raw history is never shortened in storage. */
export function assembleContext(store: ChatStore, turnId: string, config: ChatConfig): ModelMessage[] {
  const turn = store.turn(turnId);
  if(batchReady(store.db)){
    const render=(m:ChatMessage)=>m.quote&&!m.quote.unavailable?'引用的已核验消息：'+m.quote.selectedText+'\n\n'+m.content:m.content;
    const current=store.turnMessages(turnId).filter(m=>m.role==='user');let remaining=config.contextChars-current.reduce((n,m)=>n+render(m).length,0);const history=store.db.prepare("SELECT id FROM chat_turns WHERE conversation_id=? AND turn_seq<? AND status='succeeded' ORDER BY turn_seq DESC LIMIT ?").all(turn.conversationId,turn.turnSeq,config.contextTurns);const groups:ModelMessage[][]=[];
    for(const row of history){const records=store.turnMessages(String(row.id));if(!records.some(m=>m.role==='user')||!records.some(m=>m.role==='assistant'))continue;const size=records.reduce((n,m)=>n+render(m).length,0);if(size>remaining)break;remaining-=size;groups.unshift(records.map(m=>({role:m.role,content:render(m)})));}
    const persona=store.conversation(turn.conversationId)?.profile?'':config.systemPrompt;return [...(persona?[{role:'system' as const,content:persona}]:[]),{role:'system',content:'当前长期记忆和 Windows 归档检索不可用。你只能依据本次提供的近期对话作答，不得声称读取过旧记忆或编造共同经历。'},...groups.flat(),...current.map(m=>({role:m.role,content:render(m)}))];
  }
  const current = store.db.prepare("SELECT content FROM chat_messages WHERE turn_id=? AND role='user'").get(turnId)!;
  const content = String(current.content);
  let remaining = config.contextChars - content.length;
  const rows = store.db.prepare(`SELECT COALESCE(us.content,u.content) AS userContent,COALESCE(ast.content,a.content) AS assistantContent
    FROM chat_turns t JOIN chat_messages u ON u.turn_id=t.id AND u.role='user'
    JOIN chat_messages a ON a.turn_id=t.id AND a.role='assistant'
    LEFT JOIN chat_message_state us ON us.message_id=u.id LEFT JOIN chat_message_state ast ON ast.message_id=a.id
    WHERE t.conversation_id=? AND t.turn_seq<? AND t.status='succeeded' AND us.deleted_at IS NULL AND ast.deleted_at IS NULL
    ORDER BY t.turn_seq DESC LIMIT ?`).all(turn.conversationId,turn.turnSeq,config.contextTurns);
  const pairs: ModelMessage[][] = [];
  for(const row of rows) {
    const user = String(row.userContent), assistant = String(row.assistantContent);
    if(user.length + assistant.length > remaining) break;
    remaining -= user.length + assistant.length;
    pairs.unshift([{role:'user',content:user},{role:'assistant',content:assistant}]);
  }
  // A legacy global prompt is never silently reused as the persona of newly selected members.
  const systemPrompt=store.conversation(turn.conversationId)?.profile?'':config.systemPrompt;
  return [...(systemPrompt?[{role:'system' as const,content:systemPrompt}]:[]),
    {role:'system',content:'当前长期记忆和 Windows 归档检索不可用。你只能依据本次提供的近期对话作答，不得声称读取过旧记忆或编造共同经历。'},
    ...pairs.flat(),{role:'user',content}];
}
