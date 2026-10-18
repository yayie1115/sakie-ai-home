import type { BubbleOperation } from '@sakie/contracts';
import { ChatError } from '../store.js';
export function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ChatError(400, 'INVALID_OPERATION');
    const x = value as Record<string, unknown>;
    if (required.some(k => !(k in x)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k)))
        throw new ChatError(400, 'INVALID_OPERATION');
    return x;
}
export function requestId(value: unknown): string { if (typeof value !== 'string' || !(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).test(value))
    throw new ChatError(400, 'INVALID_ID'); return value; }
export function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new ChatError(400, 'INVALID_REVISION'); return Number(value); }
export function operation(value: unknown, maxChars: number): BubbleOperation {
    const x = object(value, ['requestId', 'kind', 'expectedRevision'], ['content', 'versionId']);
    requestId(x.requestId);
    revision(x.expectedRevision);
    const extra = x.kind === 'edit' ? ['content'] : x.kind === 'switch' ? ['versionId'] : [];
    object(value, ['requestId', 'kind', 'expectedRevision', ...extra]);
    if (!['edit', 'switch', 'delete', 'regenerate', 'regenerate-turn'].includes(String(x.kind)))
        throw new ChatError(400, 'INVALID_OPERATION');
    if (x.kind === 'edit' && (typeof x.content !== 'string' || !x.content.trim() || x.content.length > maxChars))
        throw new ChatError(400, 'INVALID_TEXT');
    if (x.kind === 'switch' && (typeof x.versionId !== 'string' || !x.versionId || x.versionId.length > 200))
        throw new ChatError(400, 'INVALID_VERSION');
    return x as unknown as BubbleOperation;
}
