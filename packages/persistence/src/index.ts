export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export class ConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  constructor(message: string, readonly expected?: number, readonly actual?: number) {
    super(message);
    this.name = "ConflictError";
  }
}

export class LockUnavailableError extends Error {
  readonly code = "LOCK_UNAVAILABLE";
  constructor(readonly key: string) {
    super(`Lock is unavailable: ${key}`);
    this.name = "LockUnavailableError";
  }
}

export interface SessionRecord<T = JsonValue> {
  id: string;
  value: T;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface WriteOptions {
  expectedVersion?: number;
  ttlMs?: number;
}

export interface SessionStore<T = JsonValue> {
  get(id: string): Promise<SessionRecord<T> | undefined>;
  put(id: string, value: T, options?: WriteOptions): Promise<SessionRecord<T>>;
  delete(id: string, expectedVersion?: number): Promise<boolean>;
  touch(id: string, ttlMs: number, expectedVersion?: number): Promise<SessionRecord<T> | undefined>;
}

export interface JournalEvent<T = JsonValue> {
  streamId: string;
  sequence: number;
  type: string;
  data: T;
  timestamp: number;
  id?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface AppendEvent<T = JsonValue> {
  type: string;
  data: T;
  timestamp?: number;
  id?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface EventJournal<T = JsonValue> {
  append(streamId: string, events: readonly AppendEvent<T>[], expectedSequence?: number): Promise<readonly JournalEvent<T>[]>;
  read(streamId: string, fromSequence?: number, limit?: number): Promise<readonly JournalEvent<T>[]>;
  latestSequence(streamId: string): Promise<number>;
}

export interface ConversationMessage<T = JsonValue> {
  id: string;
  role: string;
  content: T;
  createdAt: number;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface Conversation<T = JsonValue> {
  id: string;
  messages: readonly ConversationMessage<T>[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStore<T = JsonValue> {
  get(id: string): Promise<Conversation<T> | undefined>;
  save(id: string, messages: readonly ConversationMessage<T>[], expectedVersion?: number): Promise<Conversation<T>>;
  append(id: string, message: ConversationMessage<T>, expectedVersion?: number): Promise<Conversation<T>>;
  delete(id: string, expectedVersion?: number): Promise<boolean>;
}

export interface Artifact {
  key: string;
  data: Uint8Array;
  contentType?: string;
  metadata: Readonly<Record<string, string>>;
  etag: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface ArtifactWriteOptions {
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
  ifMatch?: string;
  ifNoneMatch?: boolean;
  ttlMs?: number;
}

export interface ArtifactStore {
  get(key: string): Promise<Artifact | undefined>;
  put(key: string, data: Uint8Array, options?: ArtifactWriteOptions): Promise<Artifact>;
  delete(key: string, ifMatch?: string): Promise<boolean>;
  list(prefix?: string, cursor?: string, limit?: number): Promise<{ artifacts: readonly Omit<Artifact, "data">[]; cursor?: string }>;
}

export interface IdempotencyRecord<T = JsonValue> {
  key: string;
  state: "pending" | "completed";
  owner: string;
  value?: T;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyStore<T = JsonValue> {
  claim(key: string, owner: string, ttlMs: number): Promise<{ acquired: boolean; record: IdempotencyRecord<T> }>;
  complete(key: string, owner: string, value: T, ttlMs?: number): Promise<IdempotencyRecord<T>>;
  get(key: string): Promise<IdempotencyRecord<T> | undefined>;
  release(key: string, owner: string): Promise<boolean>;
}

export interface Lease {
  key: string;
  token: string;
  fencingToken: number;
  expiresAt: number;
}

export interface CoordinationStore {
  acquire(key: string, owner: string, ttlMs: number): Promise<Lease>;
  extend(lease: Lease, ttlMs: number): Promise<Lease>;
  release(lease: Lease): Promise<boolean>;
  isLeader(key: string, lease: Lease): Promise<boolean>;
}

type Stored<T> = { value: T; expiresAt?: number };

export class InMemoryPersistence<TSession = JsonValue, TEvent = JsonValue, TMessage = JsonValue, TIdempotency = JsonValue> {
  private readonly sessions = new Map<string, Stored<SessionRecord<TSession>>>();
  private readonly journals = new Map<string, JournalEvent<TEvent>[]>();
  private readonly conversations = new Map<string, Conversation<TMessage>>();
  private readonly artifacts = new Map<string, Stored<Artifact>>();
  private readonly idempotency = new Map<string, Stored<IdempotencyRecord<TIdempotency>>>();
  private readonly leases = new Map<string, Stored<Lease>>();
  private readonly fencing = new Map<string, number>();
  private operation = Promise.resolve();

  constructor(private readonly clock: () => number = Date.now, private readonly token: () => string = randomToken) {}

  readonly sessionStore: SessionStore<TSession> = {
    get: async (id) => this.locked(() => {
      const record = this.live(this.sessions, id);
      return record ? cloneSession(record.value) : undefined;
    }),
    put: async (id, value, options = {}) => this.locked(() => {
      const now = this.clock();
      const current = this.live(this.sessions, id)?.value;
      checkVersion(options.expectedVersion, current?.version, `session ${id}`);
      const record: SessionRecord<TSession> = withExpiry({
        id, value, version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now, updatedAt: now,
      }, options.ttlMs === undefined ? current?.expiresAt : now + options.ttlMs);
      this.sessions.set(id, stored(record, record.expiresAt));
      return cloneSession(record);
    }),
    delete: async (id, expectedVersion) => this.locked(() => {
      const current = this.live(this.sessions, id)?.value;
      if (!current) return false;
      checkVersion(expectedVersion, current.version, `session ${id}`);
      return this.sessions.delete(id);
    }),
    touch: async (id, ttlMs, expectedVersion) => this.locked(() => {
      const current = this.live(this.sessions, id)?.value;
      if (!current) return undefined;
      checkVersion(expectedVersion, current.version, `session ${id}`);
      const next: SessionRecord<TSession> = { ...current, version: current.version + 1, updatedAt: this.clock(), expiresAt: this.clock() + positiveTtl(ttlMs) };
      this.sessions.set(id, stored(next, next.expiresAt));
      return cloneSession(next);
    }),
  };

  readonly eventJournal: EventJournal<TEvent> = {
    append: async (streamId, events, expectedSequence) => this.locked(() => {
      const stream = this.journals.get(streamId) ?? [];
      const latest = stream.at(-1)?.sequence ?? 0;
      if (expectedSequence !== undefined && expectedSequence !== latest) throw new ConflictError(`Sequence conflict for stream ${streamId}`, expectedSequence, latest);
      const appended = events.map((event, index): JournalEvent<TEvent> => ({
        streamId, sequence: latest + index + 1, type: event.type, data: event.data,
        timestamp: event.timestamp ?? this.clock(),
        ...(event.id === undefined ? {} : { id: event.id }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      }));
      this.journals.set(streamId, [...stream, ...appended]);
      return appended.map(cloneEvent);
    }),
    read: async (streamId, fromSequence = 1, limit = 100) => this.locked(() =>
      (this.journals.get(streamId) ?? []).filter((event) => event.sequence >= fromSequence).slice(0, validLimit(limit)).map(cloneEvent)),
    latestSequence: async (streamId) => this.locked(() => this.journals.get(streamId)?.at(-1)?.sequence ?? 0),
  };

  readonly conversationStore: ConversationStore<TMessage> = {
    get: async (id) => this.locked(() => {
      const conversation = this.conversations.get(id);
      return conversation ? cloneConversation(conversation) : undefined;
    }),
    save: async (id, messages, expectedVersion) => this.locked(() => {
      const now = this.clock();
      const current = this.conversations.get(id);
      checkVersion(expectedVersion, current?.version, `conversation ${id}`);
      const next: Conversation<TMessage> = {
        id, messages: messages.map(cloneMessage), version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now, updatedAt: now,
      };
      this.conversations.set(id, next);
      return cloneConversation(next);
    }),
    append: async (id, message, expectedVersion) => this.locked(() => {
      const now = this.clock();
      const current = this.conversations.get(id);
      checkVersion(expectedVersion, current?.version, `conversation ${id}`);
      const next: Conversation<TMessage> = {
        id, messages: [...(current?.messages ?? []), cloneMessage(message)],
        version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now,
      };
      this.conversations.set(id, next);
      return cloneConversation(next);
    }),
    delete: async (id, expectedVersion) => this.locked(() => {
      const current = this.conversations.get(id);
      if (!current) return false;
      checkVersion(expectedVersion, current.version, `conversation ${id}`);
      return this.conversations.delete(id);
    }),
  };

  readonly artifactStore: ArtifactStore = {
    get: async (key) => this.locked(() => {
      const artifact = this.live(this.artifacts, key)?.value;
      return artifact ? cloneArtifact(artifact) : undefined;
    }),
    put: async (key, data, options = {}) => this.locked(() => {
      const now = this.clock();
      const current = this.live(this.artifacts, key)?.value;
      if (options.ifNoneMatch && current) throw new ConflictError(`Artifact already exists: ${key}`);
      if (options.ifMatch !== undefined && options.ifMatch !== current?.etag) throw new ConflictError(`ETag conflict for artifact ${key}`);
      const bytes = new Uint8Array(data);
      const etag = hashBytes(bytes);
      const artifact: Artifact = withExpiry({
        key, data: bytes, metadata: { ...(options.metadata ?? {}) }, etag,
        createdAt: current?.createdAt ?? now, updatedAt: now,
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      }, options.ttlMs === undefined ? current?.expiresAt : now + positiveTtl(options.ttlMs));
      this.artifacts.set(key, stored(artifact, artifact.expiresAt));
      return cloneArtifact(artifact);
    }),
    delete: async (key, ifMatch) => this.locked(() => {
      const current = this.live(this.artifacts, key)?.value;
      if (!current) return false;
      if (ifMatch !== undefined && ifMatch !== current.etag) throw new ConflictError(`ETag conflict for artifact ${key}`);
      return this.artifacts.delete(key);
    }),
    list: async (prefix = "", cursor, limit = 100) => this.locked(() => {
      const keys = [...this.artifacts.keys()].sort().filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor));
      const selected = keys.slice(0, validLimit(limit));
      const artifacts = selected.flatMap((key) => {
        const artifact = this.live(this.artifacts, key)?.value;
        return artifact ? [withoutData(cloneArtifact(artifact))] : [];
      });
      const next = keys.length > selected.length ? selected.at(-1) : undefined;
      return next === undefined ? { artifacts } : { artifacts, cursor: next };
    }),
  };

  readonly idempotencyStore: IdempotencyStore<TIdempotency> = {
    claim: async (key, owner, ttlMs) => this.locked(() => {
      const current = this.live(this.idempotency, key)?.value;
      if (current) return { acquired: false, record: cloneIdempotency(current) };
      const now = this.clock();
      const record: IdempotencyRecord<TIdempotency> = { key, state: "pending", owner, createdAt: now, expiresAt: now + positiveTtl(ttlMs) };
      this.idempotency.set(key, stored(record, record.expiresAt));
      return { acquired: true, record: cloneIdempotency(record) };
    }),
    complete: async (key, owner, value, ttlMs) => this.locked(() => {
      const current = this.live(this.idempotency, key)?.value;
      if (!current || current.owner !== owner) throw new ConflictError(`Idempotency claim is not owned by ${owner}`);
      const expiresAt = ttlMs === undefined ? current.expiresAt : this.clock() + positiveTtl(ttlMs);
      const next: IdempotencyRecord<TIdempotency> = { ...current, state: "completed", value, expiresAt };
      this.idempotency.set(key, stored(next, expiresAt));
      return cloneIdempotency(next);
    }),
    get: async (key) => this.locked(() => {
      const record = this.live(this.idempotency, key)?.value;
      return record ? cloneIdempotency(record) : undefined;
    }),
    release: async (key, owner) => this.locked(() => {
      const current = this.live(this.idempotency, key)?.value;
      if (!current || current.owner !== owner || current.state === "completed") return false;
      return this.idempotency.delete(key);
    }),
  };

  readonly coordinationStore: CoordinationStore = {
    acquire: async (key, owner, ttlMs) => this.locked(() => {
      if (this.live(this.leases, key)) throw new LockUnavailableError(key);
      const fencingToken = (this.fencing.get(key) ?? 0) + 1;
      this.fencing.set(key, fencingToken);
      const lease: Lease = { key, token: `${owner}:${this.token()}`, fencingToken, expiresAt: this.clock() + positiveTtl(ttlMs) };
      this.leases.set(key, stored(lease, lease.expiresAt));
      return { ...lease };
    }),
    extend: async (lease, ttlMs) => this.locked(() => {
      const current = this.live(this.leases, lease.key)?.value;
      if (!current || current.token !== lease.token) throw new LockUnavailableError(lease.key);
      const next = { ...current, expiresAt: this.clock() + positiveTtl(ttlMs) };
      this.leases.set(lease.key, stored(next, next.expiresAt));
      return { ...next };
    }),
    release: async (lease) => this.locked(() => {
      const current = this.live(this.leases, lease.key)?.value;
      return Boolean(current && current.token === lease.token && this.leases.delete(lease.key));
    }),
    isLeader: async (key, lease) => this.locked(() => {
      const current = this.live(this.leases, key)?.value;
      return Boolean(current && current.token === lease.token && current.fencingToken === lease.fencingToken);
    }),
  };

  private async locked<R>(operation: () => R | Promise<R>): Promise<R> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private live<V>(map: Map<string, Stored<V>>, key: string): Stored<V> | undefined {
    const item = map.get(key);
    if (item?.expiresAt !== undefined && item.expiresAt <= this.clock()) {
      map.delete(key);
      return undefined;
    }
    return item;
  }
}

/** Convenience factory exposing each non-ambiguous contract separately. */
export function createMemoryPersistence<TSession = JsonValue, TEvent = JsonValue, TMessage = JsonValue, TIdempotency = JsonValue>(
  clock?: () => number,
): {
  sessions: SessionStore<TSession>; events: EventJournal<TEvent>; conversations: ConversationStore<TMessage>;
  artifacts: ArtifactStore; idempotency: IdempotencyStore<TIdempotency>; coordination: CoordinationStore;
} {
  const memory = new InMemoryPersistence<TSession, TEvent, TMessage, TIdempotency>(clock);
  return {
    sessions: memory.sessionStore, events: memory.eventJournal, conversations: memory.conversationStore,
    artifacts: memory.artifactStore, idempotency: memory.idempotencyStore, coordination: memory.coordinationStore,
  };
}

export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: readonly Row[];
  rowCount: number;
}
export interface SqlAdapter {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>;
  transaction<T>(operation: (connection: SqlAdapter) => Promise<T>): Promise<T>;
}
export interface RedisSetOptions { nx?: boolean; xx?: boolean; px?: number }
export interface RedisAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<"OK" | null>;
  del(...keys: readonly string[]): Promise<number>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}
export interface ObjectAdapter {
  get(key: string): Promise<{ body: Uint8Array; etag: string; contentType?: string; metadata?: Readonly<Record<string, string>>; updatedAt?: number } | undefined>;
  put(key: string, body: Uint8Array, options?: { contentType?: string; metadata?: Readonly<Record<string, string>>; ifMatch?: string; ifNoneMatch?: boolean }): Promise<{ etag: string; updatedAt?: number }>;
  delete(key: string, options?: { ifMatch?: string }): Promise<boolean>;
  list(prefix: string, cursor?: string, limit?: number): Promise<{ objects: readonly { key: string; etag: string; size?: number; updatedAt?: number; contentType?: string; metadata?: Readonly<Record<string, string>> }[]; cursor?: string }>;
}

interface SessionRow { id: string; value: unknown; version: number; created_at: number; updated_at: number; expires_at: number | null; [key: string]: unknown }

export class SqlSessionStore<T = JsonValue> implements SessionStore<T> {
  private readonly table: string;
  constructor(private readonly sql: SqlAdapter, table = "voicekit_sessions", private readonly clock: () => number = Date.now) { this.table = identifier(table); }
  async get(id: string): Promise<SessionRecord<T> | undefined> {
    const result = await this.sql.query<SessionRow>(`SELECT * FROM ${this.table} WHERE id = $1 AND (expires_at IS NULL OR expires_at > $2)`, [id, this.clock()]);
    return result.rows[0] ? sessionFromRow<T>(result.rows[0]) : undefined;
  }
  async put(id: string, value: T, options: WriteOptions = {}): Promise<SessionRecord<T>> {
    return this.sql.transaction(async (tx) => {
      const found = await tx.query<SessionRow>(`SELECT * FROM ${this.table} WHERE id = $1 FOR UPDATE`, [id]);
      const current = found.rows[0];
      checkVersion(options.expectedVersion, current?.version, `session ${id}`);
      const now = this.clock();
      const expires = options.ttlMs === undefined ? current?.expires_at ?? null : now + positiveTtl(options.ttlMs);
      const version = (current?.version ?? 0) + 1;
      const result = await tx.query<SessionRow>(
        `INSERT INTO ${this.table} (id,value,version,created_at,updated_at,expires_at) VALUES ($1,$2,$3,$4,$4,$5)
         ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at RETURNING *`,
        [id, value, version, current?.created_at ?? now, expires],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Session write returned no row");
      return sessionFromRow<T>(row);
    });
  }
  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    const result = expectedVersion === undefined
      ? await this.sql.query(`DELETE FROM ${this.table} WHERE id=$1`, [id])
      : await this.sql.query(`DELETE FROM ${this.table} WHERE id=$1 AND version=$2`, [id, expectedVersion]);
    if (expectedVersion !== undefined && result.rowCount === 0 && await this.get(id)) throw new ConflictError(`Version conflict for session ${id}`, expectedVersion);
    return result.rowCount > 0;
  }
  async touch(id: string, ttlMs: number, expectedVersion?: number): Promise<SessionRecord<T> | undefined> {
    const parameters: unknown[] = [id, this.clock(), this.clock() + positiveTtl(ttlMs)];
    const versionClause = expectedVersion === undefined ? "" : " AND version=$4";
    if (expectedVersion !== undefined) parameters.push(expectedVersion);
    const result = await this.sql.query<SessionRow>(`UPDATE ${this.table} SET expires_at=$3,updated_at=$2,version=version+1 WHERE id=$1${versionClause} RETURNING *`, parameters);
    if (!result.rows[0] && expectedVersion !== undefined && await this.get(id)) throw new ConflictError(`Version conflict for session ${id}`, expectedVersion);
    return result.rows[0] ? sessionFromRow<T>(result.rows[0]) : undefined;
  }
}

interface EventRow { stream_id: string; sequence: number; type: string; data: unknown; timestamp: number; id: string | null; metadata: unknown; [key: string]: unknown }
export class SqlEventJournal<T = JsonValue> implements EventJournal<T> {
  private readonly table: string;
  constructor(private readonly sql: SqlAdapter, table = "voicekit_events", private readonly clock: () => number = Date.now) { this.table = identifier(table); }
  async append(streamId: string, events: readonly AppendEvent<T>[], expectedSequence?: number): Promise<readonly JournalEvent<T>[]> {
    return this.sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [streamId]);
      const latestResult = await tx.query<{ sequence: number; [key: string]: unknown }>(`SELECT sequence FROM ${this.table} WHERE stream_id=$1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [streamId]);
      const latest = latestResult.rows[0]?.sequence ?? 0;
      if (expectedSequence !== undefined && expectedSequence !== latest) throw new ConflictError(`Sequence conflict for stream ${streamId}`, expectedSequence, latest);
      const appended: JournalEvent<T>[] = [];
      for (const [index, event] of events.entries()) {
        const sequence = latest + index + 1;
        const result = await tx.query<EventRow>(
          `INSERT INTO ${this.table} (stream_id,sequence,type,data,timestamp,id,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [streamId, sequence, event.type, event.data, event.timestamp ?? this.clock(), event.id ?? null, event.metadata ?? null],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Event append returned no row");
        appended.push(eventFromRow<T>(row));
      }
      return appended;
    });
  }
  async read(streamId: string, fromSequence = 1, limit = 100): Promise<readonly JournalEvent<T>[]> {
    const result = await this.sql.query<EventRow>(`SELECT * FROM ${this.table} WHERE stream_id=$1 AND sequence >= $2 ORDER BY sequence ASC LIMIT $3`, [streamId, fromSequence, validLimit(limit)]);
    return result.rows.map(eventFromRow<T>);
  }
  async latestSequence(streamId: string): Promise<number> {
    const result = await this.sql.query<{ sequence: number; [key: string]: unknown }>(`SELECT sequence FROM ${this.table} WHERE stream_id=$1 ORDER BY sequence DESC LIMIT 1`, [streamId]);
    return result.rows[0]?.sequence ?? 0;
  }
}

interface ConversationRow { id: string; messages: unknown; version: number; created_at: number; updated_at: number; [key: string]: unknown }
export class SqlConversationStore<T = JsonValue> implements ConversationStore<T> {
  private readonly table: string;
  constructor(private readonly sql: SqlAdapter, table = "voicekit_conversations", private readonly clock: () => number = Date.now) { this.table = identifier(table); }
  async get(id: string): Promise<Conversation<T> | undefined> {
    const result = await this.sql.query<ConversationRow>(`SELECT * FROM ${this.table} WHERE id=$1`, [id]);
    return result.rows[0] ? conversationFromRow<T>(result.rows[0]) : undefined;
  }
  async save(id: string, messages: readonly ConversationMessage<T>[], expectedVersion?: number): Promise<Conversation<T>> {
    return this.write(id, () => messages, expectedVersion);
  }
  async append(id: string, message: ConversationMessage<T>, expectedVersion?: number): Promise<Conversation<T>> {
    return this.write(id, (existing) => [...existing, message], expectedVersion);
  }
  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    const result = expectedVersion === undefined
      ? await this.sql.query(`DELETE FROM ${this.table} WHERE id=$1`, [id])
      : await this.sql.query(`DELETE FROM ${this.table} WHERE id=$1 AND version=$2`, [id, expectedVersion]);
    if (!result.rowCount && expectedVersion !== undefined && await this.get(id)) throw new ConflictError(`Version conflict for conversation ${id}`, expectedVersion);
    return result.rowCount > 0;
  }
  private async write(id: string, update: (messages: readonly ConversationMessage<T>[]) => readonly ConversationMessage<T>[], expectedVersion?: number): Promise<Conversation<T>> {
    return this.sql.transaction(async (tx) => {
      const found = await tx.query<ConversationRow>(`SELECT * FROM ${this.table} WHERE id=$1 FOR UPDATE`, [id]);
      const current = found.rows[0];
      checkVersion(expectedVersion, current?.version, `conversation ${id}`);
      const now = this.clock();
      const messages = update(current ? conversationFromRow<T>(current).messages : []);
      const result = await tx.query<ConversationRow>(
        `INSERT INTO ${this.table} (id,messages,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (id) DO UPDATE SET messages=EXCLUDED.messages,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at RETURNING *`,
        [id, messages, (current?.version ?? 0) + 1, current?.created_at ?? now],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Conversation write returned no row");
      return conversationFromRow<T>(row);
    });
  }
}

export class ObjectArtifactStore implements ArtifactStore {
  constructor(private readonly objects: ObjectAdapter, private readonly clock: () => number = Date.now) {}
  async get(key: string): Promise<Artifact | undefined> {
    const object = await this.objects.get(key);
    if (!object) return undefined;
    const expiresAt = parseOptionalNumber(object.metadata?.["voicekit-expires-at"]);
    if (expiresAt !== undefined && expiresAt <= this.clock()) return undefined;
    return objectToArtifact(key, object, expiresAt);
  }
  async put(key: string, data: Uint8Array, options: ArtifactWriteOptions = {}): Promise<Artifact> {
    const now = this.clock();
    const expiresAt = options.ttlMs === undefined ? undefined : now + positiveTtl(options.ttlMs);
    const metadata = { ...(options.metadata ?? {}), ...(expiresAt === undefined ? {} : { "voicekit-expires-at": String(expiresAt) }) };
    const input = {
      metadata,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
    };
    const result = await this.objects.put(key, data, input);
    return {
      key, data: new Uint8Array(data), etag: result.etag, metadata,
      createdAt: result.updatedAt ?? now, updatedAt: result.updatedAt ?? now,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  delete(key: string, ifMatch?: string): Promise<boolean> {
    return this.objects.delete(key, ifMatch === undefined ? undefined : { ifMatch });
  }
  async list(prefix = "", cursor?: string, limit = 100): Promise<{ artifacts: readonly Omit<Artifact, "data">[]; cursor?: string }> {
    const result = await this.objects.list(prefix, cursor, validLimit(limit));
    const artifacts = result.objects.flatMap((object) => {
      const expiresAt = parseOptionalNumber(object.metadata?.["voicekit-expires-at"]);
      if (expiresAt !== undefined && expiresAt <= this.clock()) return [];
      const artifact: Omit<Artifact, "data"> = {
        key: object.key, etag: object.etag, metadata: object.metadata ?? {},
        createdAt: object.updatedAt ?? 0, updatedAt: object.updatedAt ?? 0,
        ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      return [artifact];
    });
    return result.cursor === undefined ? { artifacts } : { artifacts, cursor: result.cursor };
  }
}

export class RedisIdempotencyStore<T = JsonValue> implements IdempotencyStore<T> {
  constructor(private readonly redis: RedisAdapter, private readonly prefix = "voicekit:idempotency:", private readonly clock: () => number = Date.now) {}
  async claim(key: string, owner: string, ttlMs: number): Promise<{ acquired: boolean; record: IdempotencyRecord<T> }> {
    const now = this.clock();
    const record: IdempotencyRecord<T> = { key, state: "pending", owner, createdAt: now, expiresAt: now + positiveTtl(ttlMs) };
    const acquired = await this.redis.set(this.prefix + key, JSON.stringify(record), { nx: true, px: ttlMs });
    if (acquired) return { acquired: true, record };
    const current = await this.get(key);
    if (!current) return this.claim(key, owner, ttlMs);
    return { acquired: false, record: current };
  }
  async complete(key: string, owner: string, value: T, ttlMs?: number): Promise<IdempotencyRecord<T>> {
    const current = await this.get(key);
    if (!current || current.owner !== owner) throw new ConflictError(`Idempotency claim is not owned by ${owner}`);
    const remaining = ttlMs ?? Math.max(1, current.expiresAt - this.clock());
    const next: IdempotencyRecord<T> = { ...current, state: "completed", value, expiresAt: this.clock() + positiveTtl(remaining) };
    const result = await this.redis.eval(COMPLETE_SCRIPT, [this.prefix + key], [owner, JSON.stringify(next), String(remaining)]);
    if (Number(result) !== 1) throw new ConflictError(`Idempotency claim is not owned by ${owner}`);
    return next;
  }
  async get(key: string): Promise<IdempotencyRecord<T> | undefined> {
    const value = await this.redis.get(this.prefix + key);
    return value === null ? undefined : JSON.parse(value) as IdempotencyRecord<T>;
  }
  async release(key: string, owner: string): Promise<boolean> {
    return Number(await this.redis.eval(RELEASE_IDEMPOTENCY_SCRIPT, [this.prefix + key], [owner])) === 1;
  }
}

export class RedisCoordinationStore implements CoordinationStore {
  constructor(private readonly redis: RedisAdapter, private readonly prefix = "voicekit:lock:", private readonly clock: () => number = Date.now, private readonly token: () => string = randomToken) {}
  async acquire(key: string, owner: string, ttlMs: number): Promise<Lease> {
    positiveTtl(ttlMs);
    const fencingToken = await this.redis.incr(`${this.prefix}fence:${key}`);
    const token = `${owner}:${this.token()}`;
    if (!await this.redis.set(this.prefix + key, token, { nx: true, px: ttlMs })) throw new LockUnavailableError(key);
    return { key, token, fencingToken, expiresAt: this.clock() + ttlMs };
  }
  async extend(lease: Lease, ttlMs: number): Promise<Lease> {
    if (Number(await this.redis.eval(EXTEND_LOCK_SCRIPT, [this.prefix + lease.key], [lease.token, String(positiveTtl(ttlMs))])) !== 1) throw new LockUnavailableError(lease.key);
    return { ...lease, expiresAt: this.clock() + ttlMs };
  }
  async release(lease: Lease): Promise<boolean> {
    return Number(await this.redis.eval(RELEASE_LOCK_SCRIPT, [this.prefix + lease.key], [lease.token])) === 1;
  }
  async isLeader(key: string, lease: Lease): Promise<boolean> {
    return await this.redis.get(this.prefix + key) === lease.token;
  }
}

const RELEASE_LOCK_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const EXTEND_LOCK_SCRIPT = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;
const COMPLETE_SCRIPT = `local v=redis.call("get",KEYS[1]); if not v then return 0 end; local r=cjson.decode(v); if r.owner~=ARGV[1] then return 0 end; redis.call("set",KEYS[1],ARGV[2],"PX",ARGV[3]); return 1`;
const RELEASE_IDEMPOTENCY_SCRIPT = `local v=redis.call("get",KEYS[1]); if not v then return 0 end; local r=cjson.decode(v); if r.owner==ARGV[1] and r.state=="pending" then return redis.call("del",KEYS[1]) end; return 0`;

function checkVersion(expected: number | undefined, actual: number | undefined, subject: string): void {
  if (expected !== undefined && expected !== (actual ?? 0)) throw new ConflictError(`Version conflict for ${subject}`, expected, actual ?? 0);
}
function positiveTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("TTL must be a positive finite number");
  return ttlMs;
}
function validLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Limit must be a positive integer");
  return limit;
}
function stored<T>(value: T, expiresAt?: number): Stored<T> { return expiresAt === undefined ? { value } : { value, expiresAt }; }
function withExpiry<T extends object>(value: T, expiresAt: number | undefined): T & { expiresAt?: number } {
  return expiresAt === undefined ? value : { ...value, expiresAt };
}
function cloneSession<T>(value: SessionRecord<T>): SessionRecord<T> { return { ...value }; }
function cloneEvent<T>(value: JournalEvent<T>): JournalEvent<T> { return { ...value, ...(value.metadata ? { metadata: { ...value.metadata } } : {}) }; }
function cloneMessage<T>(value: ConversationMessage<T>): ConversationMessage<T> { return { ...value, ...(value.metadata ? { metadata: { ...value.metadata } } : {}) }; }
function cloneConversation<T>(value: Conversation<T>): Conversation<T> { return { ...value, messages: value.messages.map(cloneMessage) }; }
function cloneArtifact(value: Artifact): Artifact { return { ...value, data: new Uint8Array(value.data), metadata: { ...value.metadata } }; }
function cloneIdempotency<T>(value: IdempotencyRecord<T>): IdempotencyRecord<T> { return { ...value }; }
function withoutData(value: Artifact): Omit<Artifact, "data"> { const { data: _, ...rest } = value; return rest; }
function hashBytes(data: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of data) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `${data.byteLength.toString(16)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`Invalid SQL identifier: ${value}`);
  return value;
}
function sessionFromRow<T>(row: SessionRow): SessionRecord<T> {
  return withExpiry({ id: row.id, value: row.value as T, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }, row.expires_at ?? undefined);
}
function eventFromRow<T>(row: EventRow): JournalEvent<T> {
  return {
    streamId: row.stream_id, sequence: row.sequence, type: row.type, data: row.data as T, timestamp: row.timestamp,
    ...(row.id === null ? {} : { id: row.id }),
    ...(row.metadata == null ? {} : { metadata: row.metadata as Readonly<Record<string, JsonValue>> }),
  };
}
function conversationFromRow<T>(row: ConversationRow): Conversation<T> {
  return { id: row.id, messages: row.messages as readonly ConversationMessage<T>[], version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function objectToArtifact(key: string, object: Awaited<ReturnType<ObjectAdapter["get"]>> & {}, expiresAt?: number): Artifact {
  const time = object.updatedAt ?? 0;
  return {
    key, data: new Uint8Array(object.body), etag: object.etag, metadata: object.metadata ?? {}, createdAt: time, updatedAt: time,
    ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}
