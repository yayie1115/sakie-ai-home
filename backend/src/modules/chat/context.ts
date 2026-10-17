import type { ChatConfig } from './config.js';
import type { ModelMessage } from './provider.js';
import { ChatStore } from './store.js';
/** Reads a bounded number of complete turns. Raw history is never shortened in storage. */
export function assembleContext(store: ChatStore, turnId: string, config: ChatConfig): ModelMessage[] {
  const turn = store.turn(turnId);
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
  return [{role:'system',content:config.systemPrompt},
    {role:'system',content:'当前长期记忆和 Windows 归档检索不可用。你只能依据本次提供的近期对话作答，不得声称读取过旧记忆或编造共同经历。'},
    ...pairs.flat(),{role:'user',content}];
}
