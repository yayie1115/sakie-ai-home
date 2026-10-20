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
    return this.preview?.turnId===turnId ? {content:this.preview.content,firstTokenMs:this.preview.firstTokenMs} : null;
  }
  timing(turnId:string) { return this.timings.get(turnId) ?? null; }
  private rememberTiming(turnId:string) {
    if (this.preview?.turnId!==turnId) return;
    this.timings.set(turnId,{modelMs:Math.round(performance.now()-this.preview.started),firstTokenMs:this.preview.firstTokenMs});
    if(this.timings.size>64)this.timings.delete(this.timings.keys().next().value!);
    this.preview=null;
  }
  private working: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private controller: AbortController | null = null;
  constructor(readonly store: ChatStore, private provider: ModelProvider | null, readonly config: ChatConfig) {}
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
    this.kick();
  }
  async send(message: ClientMessage) {
    const prior = this.store.findOriginal(message);
    if(prior) {const receipt=this.store.receipt(prior);return {...receipt,turn:prior,message:this.store.message(receipt.messageId)};}
    if(!this.configured) throw new ChatError(503,'MODEL_NOT_CONFIGURED');
    if(this.stopped) throw new ChatError(503,'CHAT_WORKER_UNAVAILABLE');
    const queued = Number(this.store.db.prepare("SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','running')").get()!.n);
    if(queued >= this.config.maxQueued) throw new ChatError(429,'CHAT_QUEUE_FULL');
    const receipt = await this.store.accept(message);
    this.kick();
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
    this.kick(); return this.store.turn(turnId);
  }
  private kick() {
    if(this.stopped || !this.provider || this.working) return;
    this.working = this.drain().catch(() => { console.error('Chat worker stopped: persistence failure; restart required'); this.stopped = true; this.preview=null; }).finally(() => {this.working=null;
      if(!this.stopped && this.provider && this.store.db.prepare("SELECT 1 FROM chat_turns WHERE status='queued' LIMIT 1").get()) this.kick();
    });
  }
  async idle() { await this.working; }
  async stop() { this.stopped = true; this.controller?.abort(); await this.working; }
  private async drain() {
    while(!this.stopped && this.provider) {
      const row = this.store.db.prepare("SELECT id FROM chat_turns WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if(!row) return;
      const turn = this.store.turn(String(row.id));
      const attemptId = randomUUID();
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE chat_turns SET status='running',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),turn.id);
        this.store.db.prepare("INSERT INTO chat_attempts(id,turn_id,provider,model,status,started_at) VALUES (?,?,?,?,'running',?)").run(attemptId,turn.id,this.provider!.name,this.provider!.model,new Date().toISOString());
      });
      const controller = new AbortController(); this.controller = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reply;
      this.preview={turnId:turn.id,content:'',started:performance.now(),firstTokenMs:null};
      try {
        const messages = assembleContext(this.store,turn.id,this.config);
        // Enforce deadline even for replaceable providers that fail to honor cancellation.
        const deadline = new Promise<never>((_resolve,reject) => {
          const abort = () => reject(new ModelError(this.stopped ? 'PROCESS_INTERRUPTED' : 'MODEL_TIMEOUT','unknown'));
          controller.signal.addEventListener('abort',abort,{once:true});
          timer = setTimeout(() => controller.abort(),this.config.timeoutMs);
        });
        reply = await Promise.race([this.provider.complete(messages,controller.signal,content=>{
          if(controller.signal.aborted||this.preview?.turnId!==turn.id)return;
          this.preview.content=content;
          if(content&&this.preview.firstTokenMs===null)this.preview.firstTokenMs=Math.round(performance.now()-this.preview.started);
        }),deadline]);
      } catch(error) {
        const failure = error instanceof ModelError ? error : new ModelError('MODEL_CALL_FAILED','unknown');
        this.finishFailure(turn,attemptId,failure); continue;
      } finally { if(timer) clearTimeout(timer); this.controller = null; this.rememberTiming(turn.id); }
      // Persist reply, successful outcome and outbox atomically; a DB error must not be reported as a supplier error.
      this.store.transaction(() => {
        const now = new Date().toISOString();
        this.store.appendMessage({id:randomUUID(),conversationId:turn.conversationId,turnId:turn.id,messageSeq:turn.turnSeq*2,role:'assistant',content:reply.content,createdAt:now});
        this.store.db.prepare("UPDATE chat_turns SET status='succeeded',error_code=NULL,updated_at=? WHERE id=?").run(now,turn.id);
        this.store.db.prepare("UPDATE chat_attempts SET status='succeeded',finished_at=?,provider_request_id=? WHERE id=?").run(now,reply.requestId,attemptId);
        this.recordUsage(attemptId,reply.usage);
      });
    }
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
  }
}
