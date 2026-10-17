/** MEM-01 isolated prototype. In-memory only: no database, API calls, or production side effects. */
export type Context = 'real' | 'game' | 'group' | 'private' | 'simulation';
export type Kind = 'fact' | 'impression' | 'preference' | 'event' | 'promise';
export type Scope = { type: 'private'; actors: string[] } | { type: 'group'; actors: string[] };
export type Source = {
  id: string; version: string; context: Context; scope: Scope;
  active: boolean; deleted: boolean; occurredAt: string;
};
export type Memory = {
  id: string; owner: string; sourceId: string; sourceVersion: string;
  kind: Kind; statement: string; confidence: number; salience: number;
  createdAt: string; supersedes?: string; perspective?: string;
};
export type Recall = { status: 'ok' | 'no_match' | 'unavailable'; memories: Memory[] };
export type NewMemory = Omit<Memory, 'createdAt'>;

function assertId(value: string): void {
  if (!value || !value.trim()) throw new Error('missing_id');
}
function normalize(text: string): string { return text.normalize('NFKC').trim().toLocaleLowerCase(); }
function allowed(source: Source, actor: string): boolean {
  return source.scope.actors.includes(actor);
}
function valid(source: Source, version: string): boolean {
  return !source.deleted && source.active && source.version === version;
}
function evidence(source: Source, memory: NewMemory): void {
  if (!valid(source, memory.sourceVersion)) throw new Error('invalid_source_version');
  if (!allowed(source, memory.owner)) throw new Error('owner_not_authorized');
  if (!memory.statement.trim()) throw new Error('empty_claim');
  if (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1) throw new Error('invalid_confidence');
  if (!Number.isFinite(memory.salience) || memory.salience < 0 || memory.salience > 1) throw new Error('invalid_salience');
  if (memory.kind === 'impression' && !memory.perspective?.trim()) throw new Error('impression_needs_perspective');
  if (memory.kind === 'fact' && source.context === 'simulation') throw new Error('simulated_fact_disallowed');
  if (memory.kind === 'fact' && source.context === 'game') throw new Error('game_fact_disallowed');
}
export class MemoryStore {
  private sources = new Map<string, Source>();
  private memories = new Map<string, Memory>();
  private ready = true;
  setAvailable(ready: boolean): void { this.ready = ready; }
  putSource(source: Source): void {
    assertId(source.id); assertId(source.version);
    if (Number.isNaN(Date.parse(source.occurredAt))) throw new Error('invalid_time');
    if (source.deleted && source.active) throw new Error('deleted_active_conflict');
    if (!source.scope.actors.length) throw new Error('empty_scope');
    const old = this.sources.get(source.id);
    // Deletions are terminal in this prototype. Restoring a source requires an explicit separate workflow.
    if (old?.deleted && !source.deleted) throw new Error('source_deleted_terminal');
    // Cannot silently turn a previously excluded actor into a newly authorized one.
    // Explicit scope replacement is allowed; retrieval rechecks current scope.
    this.sources.set(source.id, structuredClone(source));
  }
  revoke(id: string): void {
    const source = this.sources.get(id);
    if (!source) throw new Error('source_missing');
    this.sources.set(id, { ...source, deleted: true, active: false });
  }
  add(memory: NewMemory, timestamp = new Date().toISOString()): Memory {
    assertId(memory.id); assertId(memory.owner); assertId(memory.sourceId);
    const source = this.sources.get(memory.sourceId);
    if (!source) throw new Error('source_missing');
    evidence(source, memory);
    const existing = this.memories.get(memory.id);
    if (existing) {
      const { createdAt: _ignored, ...body } = existing;
      if (JSON.stringify(body) !== JSON.stringify(memory)) throw new Error('memory_id_conflict');
      return structuredClone(existing);
    }
    if (memory.supersedes) {
      const previous = this.memories.get(memory.supersedes);
      if (!previous || previous.owner !== memory.owner || previous.kind !== memory.kind) throw new Error('invalid_revision');
      if (this.memories.has(memory.id)) throw new Error('memory_id_conflict');
    }
    if (Number.isNaN(Date.parse(timestamp))) throw new Error('invalid_time');
    const record = { ...structuredClone(memory), createdAt: timestamp };
    this.memories.set(record.id, record);
    return structuredClone(record);
  }
  recall(actor: string, query: string, limit = 5): Recall {
    if (!this.ready) return { status: 'unavailable', memories: [] };
    if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 20) return { status: 'no_match', memories: [] };
    const words = normalize(query).split(/[\s,，。！？?!.、]+/).filter(Boolean);
    const candidates = [...this.memories.values()].filter((m) => {
      const source = this.sources.get(m.sourceId);
      if (!source || !valid(source, m.sourceVersion) || !allowed(source, actor) || m.owner !== actor) return false;
      const superseded = [...this.memories.values()].some((other) => other.supersedes === m.id && other.owner === actor &&
        (this.sources.get(other.sourceId) && valid(this.sources.get(other.sourceId)!, other.sourceVersion) && allowed(this.sources.get(other.sourceId)!, actor)));
      return !superseded;
    });
    const scored = candidates.map(m => {
      const hay = normalize(m.statement);
      const count = words.filter(w => hay.includes(w)).length;
      return { m, score: words.length ? count / words.length : 0 };
    }).filter(x => x.score > 0)
      .sort((a,b) => b.score - a.score || b.m.salience - a.m.salience || a.m.id.localeCompare(b.m.id))
      .slice(0,limit).map(x => structuredClone(x.m));
    return { status: scored.length ? 'ok' : 'no_match', memories: scored };
  }
  // Debug-only synthetic view. Not a production history read API.
  inspect(id: string): Memory | undefined { const m = this.memories.get(id); return m && structuredClone(m); }
}
