# @jchaffin/voicekit-persistence

Storage contracts for VoiceKit sessions, ordered event journals, conversations,
artifacts, idempotency, and distributed coordination.

The package includes a concurrency-safe in-memory implementation, PostgreSQL-
oriented SQL stores, Redis idempotency and coordination stores, and a
delegating object/blob artifact store. Adapters depend only on small structural
ports, so existing database clients can be wrapped without runtime dependencies.

```ts
import { createMemoryPersistence } from "@jchaffin/voicekit-persistence";

const stores = createMemoryPersistence();
const session = await stores.sessions.put("session-1", { state: "active" }, {
  expectedVersion: 0,
  ttlMs: 60_000,
});

await stores.events.append("session-1", [
  { type: "session.started", data: { version: session.version } },
], 0);
```

SQL adapters expect tables matching the exported record fields and use
PostgreSQL `$n` parameters, `ON CONFLICT`, and row locks. Redis adapters use
atomic Lua compare-and-release/extend operations. Object adapters map directly
to common blob client get/put/delete/list operations.
