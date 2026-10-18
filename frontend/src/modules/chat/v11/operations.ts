/** Immutable operation snapshot; a lost ACK must replay the SAME request ID. */
export interface PendingOperation {
    schema: 1;
    path: string;
    body: Record<string, unknown> & {
        requestId: string;
    };
}
export interface OperationAck {
    requestId: string;
    durable: true;
    jobId?: string;
}
export class OperationClient {
    constructor(readonly transport: (p: PendingOperation) => Promise<OperationAck>, readonly storage: {
        read(): unknown;
        write(p: PendingOperation): void;
        clear(): void;
    }) { }
    pending(): PendingOperation | null {
        const p = this.storage.read() as PendingOperation | null;
        if (!p)
            return null;
        if (p.schema !== 1 || !/^\/(bubbles\/[0-9a-f-]+\/operations|jobs\/[0-9a-f-]+\/(cancel|retry))$/i.test(p.path) || !p.body || typeof p.body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.body.requestId))
            throw Error('操作快照损坏，停止发送并保留现场');
        return p;
    }
    async send(path: string, body: PendingOperation['body']) {
        const old = this.pending(), p: PendingOperation = { schema: 1, path, body: structuredClone(body) };
        if (old && JSON.stringify(old) !== JSON.stringify(p))
            throw Error('存在未确认操作，请先重试原操作');
        if (!old) {
            try {
                this.storage.write(p);
            }
            catch {
                throw Error('无法保存操作编号，已停止发送');
            }
        }
        const ack = await this.transport(old ?? p);
        if (ack.requestId !== p.body.requestId || ack.durable !== true)
            throw Error('操作回执不匹配，保留原操作编号');
        return ack;
    }
    confirm(ack: OperationAck) { if (this.pending()?.body.requestId !== ack.requestId)
        throw Error('操作确认不匹配'); this.storage.clear(); }
    reject() { this.storage.clear(); }
}
