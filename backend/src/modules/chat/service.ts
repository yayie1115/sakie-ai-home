import {LiveOperations,currentMessage} from './live-operations.js';
import {reviseMessage} from '../sync/mutations.js';
import {reviseSegment} from './live-batch.js';
import type {ChatMemory} from '../memory-next/live/chat-bridge.js';
import { randomUUID } from 'node:crypto';
import type { ClientMessage, ChatTurn } from '@sakie/contracts';
import type { ChatConfig } from './config.js';
import { assembleContext } from './context.js';
import { ModelError, type ModelProvider, type ProviderUsage } from './provider.js';
import { ChatError, ChatStore } from './store.js';
/** Exactly one backend process owns this SQLite queue. No LLM polling timer. */
export class ChatService {
  // At most one active model call; preview is volatile and never a durable message.
  private preview: {turnId:string;content:string;started:number;firstTokenMs:number|null} | null = null;
  private readonly timings = new Map<string,{modelMs:number;firstTokenMs:number|null}>();
  progress(turnId:string) {
    if(this.preview?.turnId===turnId){try{this.memory?.assertCurrent(this.store.turn(turnId));}catch{this.preview=null;this.controller?.abort(new ModelError('MEMORY_SOURCES_CHANGED','unknown'));return null;}}
    return this.preview?.turnId===turnId ? {content:this.preview.content,firstTokenMs:this.preview.firstTokenMs} : null;
  }
  timing(turnId:string) { return this.timings.get(turnId) ?? null; }
  private rememberTiming(turnId:string) {
    if (this.preview?.turnId!==turnId) return;
    this.timings.set(turnId,{modelMs:Math.round(performance.now()-this.preview.started),firstTokenMs:this.preview.firstTokenMs});
    if(this.timings.size>64)this.timings.delete(this.timings.keys().next().value!);
    this.preview=null;
  }
  private readonly epoch = randomUUID();
  private readonly listeners = new Map<string, Set<() => void>>();
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  cursor(turnId: string) {
    return this.epoch + ':' + this.store.turn(turnId).status + ':' + (this.progress(turnId)?.content.length ?? 0);
  }
  private notify(turnId: string) { for (const listener of [...(this.listeners.get(turnId) ?? [])]) listener(); }
  /** Bounded authenticated long poll; no SQLite polling loop, durable state or extra worker. */
  async waitForChange(turnId: string, after: string, signal: AbortSignal) {
    if (signal.aborted || !['queued','running'].includes(this.store.turn(turnId).status) || this.cursor(turnId) !== after) return;
    if ([...this.listeners.values()].reduce((n, set) => n + set.size, 0) >= 64) throw new ChatError(429, 'CHAT_PROGRESS_BUSY');
    await new Promise<void>(resolve => {
      const listeners = this.listeners.get(turnId) ?? new Set<() => void>();
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener('abort', finish); listeners.delete(finish);
        if (!listeners.size) this.listeners.delete(turnId);
        resolve();
      };
      const timer = setTimeout(finish, 20000);
      listeners.add(finish); this.listeners.set(turnId, listeners);
      signal.addEventListener('abort', finish, {once:true});
      if (signal.aborted || this.cursor(turnId) !== after) finish();
    });
  }
  readonly operations:LiveOperations;
  private generationController:{id:string;controller:AbortController}|null=null;
  private working: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private controller: AbortController | null = null;
  constructor(readonly store: ChatStore, private provider: ModelProvider | null, readonly config: ChatConfig, private memory?:ChatMemory) {this.operations=new LiveOperations(store,config.contextTurns);memory?.onInvalidate(id=>{if(this.preview?.turnId===id){this.preview=null;this.controller?.abort(new ModelError('MEMORY_SOURCES_CHANGED','unknown'));this.generationController?.controller.abort(new ModelError('MEMORY_SOURCES_CHANGED','unknown'));this.notify(id);}});}
  get configured() { return this.provider !== null; }
  start() {
    if(this.started) return;
    this.started = true;
    // A running attempt after process death has an unknown supplier outcome, not a safe automatic retry.
    this.store.transaction(() => {
      const now = new Date().toISOString();
      this.store.db.prepare("UPDATE chat_attempts SET status='unknown',error_code='PROCESS_INTERRUPTED',finished_at=? WHERE status='running'").run(now);
      this.store.db.prepare("UPDATE chat_turns SET status='unknown',error_code='PROCESS_INTERRUPTED',updated_at=? WHERE status='running'").run(now);
    });
    this.operations.recover();this.kick();
  }
  async send(message: ClientMessage) {
    const prior = this.store.findOriginal(message);
    if(prior) {const receipt=this.store.receipt(prior);return {...receipt,turn:prior,message:this.store.message(receipt.messageId)};}
    if(this.operations.active(message.conversationId))throw new ChatError(409,'GENERATION_IN_PROGRESS');
    if(!this.configured) throw new ChatError(503,'MODEL_NOT_CONFIGURED');
    if(this.stopped) throw new ChatError(503,'CHAT_WORKER_UNAVAILABLE');
    const queued = Number(this.store.db.prepare("SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','running')").get()!.n);
    if(queued+(this.operations.ready?Number(this.store.db.prepare("SELECT count(*) n FROM chat_live_generations WHERE status IN ('pending','running')").get()!.n):0) >= this.config.maxQueued) throw new ChatError(429,'CHAT_QUEUE_FULL');
    const receipt = await this.store.accept(message);
    this.notify(receipt.turnId); this.kick();
    return {...receipt,turn:this.store.turn(receipt.turnId),message:this.store.message(receipt.messageId)};
  }
  retry(turnId: string, retryId: string, acknowledgeUnknown: boolean) {
    this.store.transaction(() => {
      const previous = this.store.db.prepare('SELECT turn_id FROM chat_retry_requests WHERE id=?').get(retryId);
      if(previous) { if(previous.turn_id !== turnId) throw new ChatError(409,'RETRY_ID_CONFLICT'); return; }
      const turn = this.store.turn(turnId);
      if(this.stopped) throw new ChatError(503,'CHAT_WORKER_UNAVAILABLE');
      if(!this.configured) throw new ChatError(503,'MODEL_NOT_CONFIGURED');
      if(!['failed','unknown'].includes(turn.status)) throw new ChatError(409,'TURN_NOT_RETRYABLE');
      if(turn.status === 'unknown' && !acknowledgeUnknown) throw new ChatError(409,'UNKNOWN_OUTCOME_REQUIRES_ACKNOWLEDGEMENT');
      const count = Number(this.store.db.prepare("SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','running')").get()!.n);
      if(count >= this.config.maxQueued) throw new ChatError(429,'CHAT_QUEUE_FULL');
      const now = new Date().toISOString();
      this.store.db.prepare('INSERT INTO chat_retry_requests VALUES (?,?,?)').run(retryId,turnId,now);
      this.store.db.prepare("UPDATE chat_turns SET status='queued',error_code=NULL,updated_at=? WHERE id=?").run(now,turnId);
    });
    this.notify(turnId); this.kick(); return this.store.turn(turnId);
  }
  private kick() {
    if(this.stopped || !this.provider || this.working) return;
    this.working = this.drain().catch(() => { console.error('Chat worker stopped: persistence failure; restart required'); this.stopped = true; this.preview=null; }).finally(() => {this.working=null;
      if(!this.stopped && this.provider && (this.store.db.prepare("SELECT 1 FROM chat_turns WHERE status='queued' LIMIT 1").get()||this.operations.next())) this.kick();
    });
  }
  async idle() { await this.working; }
  async stop() {
    this.stopped = true; this.controller?.abort();this.generationController?.controller.abort(); await this.working;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    for (const id of this.listeners.keys()) this.notify(id);
  }
  private async drain() {
    while(!this.stopped && this.provider) {
      const row = this.store.db.prepare("SELECT id FROM chat_turns WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if(!row){const job=this.operations.next();if(job){await this.runRegeneration(String(job.id));continue;}return;}
      const turn = this.store.turn(String(row.id));
      const attemptId = randomUUID();
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE chat_turns SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),turn.id);
        this.store.db.prepare("INSERT INTO chat_attempts(id,turn_id,provider,model,status,started_at) VALUES (?,?,?,?,'running',?)").run(attemptId,turn.id,this.provider!.name,this.provider!.model,new Date().toISOString());
      });
      const controller = new AbortController(); this.controller = controller;
      let reply;
      this.preview={turnId:turn.id,content:'',started:performance.now(),firstTokenMs:null};
      this.notify(turn.id);
      try {
        reply=await this.generate(turn,controller);

      } catch(error) {
        const failure = error instanceof ModelError ? error : new ModelError('MODEL_CALL_FAILED','unknown');
        this.finishFailure(turn,attemptId,failure); continue;
      } finally { if(this.progressTimer){clearTimeout(this.progressTimer);this.progressTimer=undefined;} this.controller = null; this.rememberTiming(turn.id); }
      // Persist reply, successful outcome and outbox atomically; a DB error must not be reported as a supplier error.
      try{this.store.transaction(() => {
        try{this.memory?.assertCurrent(turn);}catch{throw new ModelError('MEMORY_SOURCES_CHANGED','failed',reply.usage);}
        const now = new Date().toISOString();
        this.store.appendMessage({id:randomUUID(),conversationId:turn.conversationId,turnId:turn.id,messageSeq:turn.turnSeq*2,role:'assistant',content:reply.content,createdAt:now});
        this.store.db.prepare("UPDATE chat_turns SET status='succeeded',error_code=NULL,updated_at=? WHERE id=?").run(now,turn.id);
        this.store.db.prepare("UPDATE chat_attempts SET status='succeeded',finished_at=?,provider_request_id=? WHERE id=?").run(now,reply.requestId,attemptId);
        this.recordUsage(attemptId,reply.usage);
        this.memory?.completed(turn);
      });}catch(e){if(e instanceof ModelError&&e.code==='MEMORY_SOURCES_CHANGED'){this.finishFailure(turn,attemptId,e);continue;}throw e;}
      this.memory?.release(turn.id);
      this.notify(turn.id);
    }
  }

  private async generate(turn:ChatTurn,controller:AbortController,readOnlyTools=false){
    let timer:ReturnType<typeof setTimeout>|undefined;let reply;
    try{
        if(controller.signal.aborted)throw new ModelError('PROCESS_INTERRUPTED','unknown');
        const messages = assembleContext(this.store,turn.id,this.config);
        if(this.memory?.isEnabled()){
          // Keep existing persona/config messages unchanged; replace only the obsolete unavailable marker.
          const marker=messages.findIndex(m=>m.role==='system'&&m.content.startsWith('当前长期记忆和 Windows 归档检索不可用'));
          if(marker>=0)messages.splice(marker,1);
          messages.splice(messages.length-1,0,...this.memory.context(turn));
        }
        // Enforce deadline even for replaceable providers that fail to honor cancellation.
        const deadline = new Promise<never>((_resolve,reject) => {
          const abort = () => reject(controller.signal.reason instanceof ModelError?controller.signal.reason:new ModelError(this.stopped ? 'PROCESS_INTERRUPTED' : 'MODEL_TIMEOUT','unknown'));
          controller.signal.addEventListener('abort',abort,{once:true});
          timer = setTimeout(() => controller.abort(),this.config.timeoutMs);
        });
        const tools=(this.memory?.tools(turn)??[]).filter(t=>!readOnlyTools||t.function.name==='memory_search');let rounds=0;
        let accumulated:ProviderUsage|undefined;
        while(true){
        try{this.memory?.assertCurrent(turn);}catch{throw new ModelError('MEMORY_SOURCES_CHANGED','failed',accumulated);}
        try{reply = await Promise.race([this.provider!.complete(messages,controller.signal,content=>{
          if(controller.signal.aborted||this.preview?.turnId!==turn.id)return;
          this.preview.content=content;
          if (!this.progressTimer) this.progressTimer = setTimeout(() => { this.progressTimer=undefined; this.notify(turn.id); }, 100);
          if(content&&this.preview.firstTokenMs===null)this.preview.firstTokenMs=Math.round(performance.now()-this.preview.started);
        },tools.length&&rounds<(this.memory?.maxToolRounds??0)?{tools}:undefined),deadline]);}catch(e){if(rounds===0&&tools.length&&e instanceof ModelError&&['MODEL_HTTP_400','MODEL_HTTP_422'].includes(e.code)){tools.length=0;messages.push({role:'system',content:'主动记忆工具本轮不可用。仅使用已提供的获准资料与近期对话，不声称完成了主动检索。'});continue;}throw e;}
        const usage=reply.usage;accumulated=accumulated?{inputTokens:sum(accumulated.inputTokens,usage.inputTokens),outputTokens:sum(accumulated.outputTokens,usage.outputTokens),cacheReadTokens:sum(accumulated.cacheReadTokens,usage.cacheReadTokens),cacheWriteTokens:sum(accumulated.cacheWriteTokens,usage.cacheWriteTokens),cacheMissTokens:sum(accumulated.cacheMissTokens??null,usage.cacheMissTokens??null)}:usage;
        if(!reply.toolCalls?.length){try{this.memory?.assertCurrent(turn);}catch{throw new ModelError('MEMORY_SOURCES_CHANGED','failed',accumulated);}reply={...reply,usage:accumulated};break;}
        if(!tools.length||++rounds>(this.memory?.maxToolRounds??0))throw new ModelError('MEMORY_TOOL_BUDGET_EXCEEDED','failed',accumulated);
        messages.push({role:'assistant',content:reply.content,tool_calls:reply.toolCalls});
        if(this.preview)this.preview.content='';
        for(const call of reply.toolCalls){if(!tools.some(t=>t.function.name===call.function.name))throw new ModelError('MODEL_UNKNOWN_TOOL','failed',accumulated);
          const result=await this.memory!.runTool(turn,call.function.name,call.function.arguments);
          const outcome=JSON.parse(result) as {status?:string;error?:string};console.info(JSON.stringify({event:'memory_tool_result',tool:call.function.name,status:outcome.status??'ok',...(outcome.error&&/^[A-Z_]+$/.test(outcome.error)?{code:outcome.error}:{})}));
          messages.push({role:'tool',tool_call_id:call.id,content:result});}
        }
      return reply;
    }finally{if(timer)clearTimeout(timer);}
  }
  regenerate(id:string,messageId:string,scope:'bubble'|'turn',base:number){
    const prior=this.operations.ready&&this.store.db.prepare('SELECT id FROM chat_live_generations WHERE id=?').get(id);
    if(!prior&&(!this.configured||this.stopped))throw new ChatError(503,'CHAT_WORKER_UNAVAILABLE');
    if(!prior){const count=Number(this.store.db.prepare("SELECT count(*) n FROM chat_turns WHERE status IN ('queued','running')").get()!.n)+(this.operations.ready?Number(this.store.db.prepare("SELECT count(*) n FROM chat_live_generations WHERE status IN ('pending','running')").get()!.n):0);if(count>=this.config.maxQueued)throw new ChatError(429,'CHAT_QUEUE_FULL');}
    const result=this.operations.enqueue(id,messageId,scope,base);this.kick();return result;
  }
  cancelGeneration(id:string){if(this.generationController?.id===id&&this.preview){this.operations.view(id);this.store.db.prepare("UPDATE chat_live_generations SET partial=? WHERE id=? AND status='running'").run(this.preview.content,id);}const result=this.operations.cancel(id);if(this.generationController?.id===id)this.generationController.controller.abort(new ModelError('USER_CANCELLED','unknown'));return result;}
  private async runRegeneration(id:string){
    const db=this.store.db;let turn:ChatTurn|undefined;const controller=new AbortController();this.generationController={id,controller};let lastWrite=0;
    try{
      db.prepare("UPDATE chat_live_generations SET status='running',provider=?,model=?,updated_at=? WHERE id=? AND status='pending'").run(this.provider!.name,this.provider!.model,new Date().toISOString(),id);
      const row=this.operations.assertCurrent(id);turn=this.store.turn(String(row.turn_id));
      this.preview={turnId:turn.id,content:'',started:performance.now(),firstTokenMs:null};
      // Persist partial output on a bounded timer, independently from the active message version.
      const persist=()=>{if(this.preview?.turnId!==turn!.id)return;try{this.operations.assertCurrent(id);db.prepare("UPDATE chat_live_generations SET partial=?,updated_at=? WHERE id=? AND status='running'").run(this.preview.content,new Date().toISOString(),id);lastWrite=Date.now();}catch{controller.abort(new ModelError('GENERATION_SOURCES_CHANGED','failed'));}};
      const timer=setInterval(()=>{if(Date.now()-lastWrite>=250)persist();},250);
      let reply;try{reply=await this.generate(turn,controller,true);}finally{clearInterval(timer);persist();}
      if(controller.signal.aborted)throw new ModelError('GENERATION_INTERRUPTED','unknown',reply.usage);
      this.store.transaction(()=>{
        this.operations.assertCurrent(id);this.memory?.assertCurrent(turn!);
        const current=currentMessage(this.store,String(row.message_id));if(current.revision!==Number(row.base_revision))throw new ChatError(409,'REVISION_CONFLICT');
        const mutation=reviseSegment(db,current.id,current.revision,id,reply.content,false)??reviseMessage(db,current.id,current.revision,id,reply.content,false);
        db.prepare("UPDATE chat_live_generations SET status='succeeded',partial=?,result_revision=?,usage_json=?,provider_request_id=?,context_hash=?,updated_at=? WHERE id=?").run(reply.content,Number(mutation.revision),JSON.stringify(reply.usage),reply.requestId,this.operations.snapshot(current.id),new Date().toISOString(),id);
      });
      this.memory?.release(turn.id);this.memory?.completed(turn);
    }catch(error){
      const row=db.prepare('SELECT status FROM chat_live_generations WHERE id=?').get(id);
      if(row?.status==='running')db.prepare("UPDATE chat_live_generations SET status=?,error_code=?,usage_json=?,updated_at=? WHERE id=?").run(error instanceof ModelError?error.outcome:'failed',error instanceof ChatError?error.code:error instanceof ModelError?error.code:'GENERATION_FAILED',error instanceof ModelError&&error.usage?JSON.stringify(error.usage):null,new Date().toISOString(),id);
    }finally{if(turn){this.memory?.release(turn.id);this.rememberTiming(turn.id);}this.generationController=null;}
  }

  private recordUsage(attemptId: string, usage?: ProviderUsage) {
    if(usage) this.store.db.prepare('UPDATE chat_attempts SET input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cache_miss_tokens=? WHERE id=?').run(usage.inputTokens,usage.outputTokens,usage.cacheReadTokens,usage.cacheWriteTokens,usage.cacheMissTokens??null,attemptId);
  }
  private finishFailure(turn: ChatTurn, attemptId: string, failure: ModelError) {
    this.store.transaction(() => {
      const now = new Date().toISOString();
      this.store.db.prepare('UPDATE chat_turns SET status=?,error_code=?,updated_at=? WHERE id=?').run(failure.outcome,failure.code,now,turn.id);
      this.store.db.prepare('UPDATE chat_attempts SET status=?,error_code=?,finished_at=? WHERE id=?').run(failure.outcome,failure.code,now,attemptId);
      this.recordUsage(attemptId,failure.usage);
    });
    this.memory?.release(turn.id);this.notify(turn.id);
  }
}

function sum(a:number|null,b:number|null){return a===null||b===null?null:a+b;}
