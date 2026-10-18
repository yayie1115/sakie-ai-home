/** Synthetic-only incremental runner. No provider settings, network or paid model. */
import { setTimeout as delay } from 'node:timers/promises';
import type { GenerationView } from '@sakie/contracts';
import { ChatOpsService } from './ops-service.js';
export interface SyntheticChunk {
    bubbleId: string;
    text: string;
}
export type SyntheticGenerator = (job: GenerationView, targets: string[], signal: AbortSignal) => AsyncIterable<SyntheticChunk>;
export function fakeGenerator(service: ChatOpsService, interval = 80): SyntheticGenerator {
    return async function* (job, targets, signal) {
        const inputs = service.current(service.legacy.turn(job.turnId).conversationId).filter(b => b.turnId === job.turnId && b.role === 'user').map(b => b.content).join(' / ');
        for (const [index, bubbleId] of targets.entries()) {
            const text = job.kind === 'reply' ? '[合成回复] ' + inputs : '[合成重生成 ' + (index + 1) + '] ' + inputs;
            const n = Math.max(1, Math.ceil(text.length / 3));
            for (let start = 0; start < text.length; start += n) {
                await delay(interval, undefined, { signal });
                yield { bubbleId, text: text.slice(start, start + n) };
            }
        }
    };
}
export class FakeGenerationRunner {
    private active = new Map<string, Promise<void>>();
    private again = new Set<string>();
    private controllers = new Set<AbortController>();
    private closing = false;
    constructor(readonly service: ChatOpsService, readonly generate: SyntheticGenerator = fakeGenerator(service)) { }
    kick(jobId: string) {
        if (this.closing)
            return Promise.resolve();
        const existing = this.active.get(jobId);
        if (existing) {
            this.again.add(jobId);
            return existing;
        }
        const task = this.run(jobId).finally(() => { this.active.delete(jobId); if (!this.closing && this.again.delete(jobId)) {
            try {
                if (this.service.generation(jobId).status === 'queued')
                    void this.kick(jobId);
            }
            catch { /* Denied scopes stay stopped. */ }
        } });
        this.active.set(jobId, task);
        return task;
    }
    private async run(jobId: string) {
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            if (this.service.generation(jobId).status !== 'queued')
                return;
            const targets = this.service.ensureTargets(jobId);
            this.service.start(jobId);
            const job = this.service.generation(jobId);
            let seq = 0;
            for await (const chunk of this.generate(job, targets, controller.signal)) {
                if (controller.signal.aborted || this.service.generation(jobId).status !== 'running' || this.service.generation(jobId).attempt !== job.attempt)
                    return;
                this.service.appendChunk(jobId, job.attempt, ++seq, chunk.bubbleId, chunk.text);
            }
            if (!controller.signal.aborted && this.service.generation(jobId).status === 'running')
                this.service.finishChunks(jobId);
        }
        catch (error) {
            if (!this.closing) {
                try {
                    this.service.stopFailed(jobId);
                }
                catch { /* Permission loss leaves durable running state for explicit recovery; never publishes output. */ }
            }
        }
        finally {
            this.controllers.delete(controller);
        }
    }
    async close() { this.closing = true; for (const c of this.controllers)
        c.abort(); await Promise.all(this.active.values()); this.service.recoverInterrupted(); }
}
