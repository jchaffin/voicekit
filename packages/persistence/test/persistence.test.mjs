import assert from "node:assert/strict";
import test from "node:test";
import {
  ConflictError,
  LockUnavailableError,
  createMemoryPersistence,
} from "../dist/index.js";

test("sessions enforce optimistic concurrency and TTL", async () => {
  let now = 1_000;
  const { sessions } = createMemoryPersistence(() => now);
  const first = await sessions.put("s1", { state: "active" }, { expectedVersion: 0, ttlMs: 50 });
  assert.equal(first.version, 1);
  await assert.rejects(() => sessions.put("s1", { state: "done" }, { expectedVersion: 0 }), ConflictError);
  const second = await sessions.put("s1", { state: "done" }, { expectedVersion: 1 });
  assert.equal(second.version, 2);
  now = 1_051;
  assert.equal(await sessions.get("s1"), undefined);
});

test("journal appends atomically in sequence order", async () => {
  const { events } = createMemoryPersistence();
  const appended = await events.append("stream", [
    { type: "started", data: { n: 1 } },
    { type: "ended", data: { n: 2 } },
  ], 0);
  assert.deepEqual(appended.map((event) => event.sequence), [1, 2]);
  await assert.rejects(() => events.append("stream", [{ type: "late", data: null }], 0), ConflictError);
  assert.deepEqual((await events.read("stream")).map((event) => event.type), ["started", "ended"]);
});

test("conversations, artifacts, and idempotency preserve contracts", async () => {
  const stores = createMemoryPersistence();
  const conversation = await stores.conversations.append("c1", { id: "m1", role: "user", content: "hello", createdAt: 1 }, 0);
  assert.equal(conversation.version, 1);
  const artifact = await stores.artifacts.put("audio/a", new Uint8Array([1, 2]), { ifNoneMatch: true });
  assert.deepEqual((await stores.artifacts.get("audio/a")).data, new Uint8Array([1, 2]));
  await assert.rejects(() => stores.artifacts.put("audio/a", new Uint8Array(), { ifNoneMatch: true }), ConflictError);
  const claim = await stores.idempotency.claim("request", "worker-1", 1_000);
  assert.equal(claim.acquired, true);
  assert.equal((await stores.idempotency.claim("request", "worker-2", 1_000)).acquired, false);
  assert.equal((await stores.idempotency.complete("request", "worker-1", { artifact: artifact.etag })).state, "completed");
});

test("coordination provides exclusive, fenced leases", async () => {
  let now = 100;
  const stores = createMemoryPersistence(() => now);
  const first = await stores.coordination.acquire("leader", "one", 10);
  await assert.rejects(() => stores.coordination.acquire("leader", "two", 10), LockUnavailableError);
  now = 111;
  const second = await stores.coordination.acquire("leader", "two", 10);
  assert.ok(second.fencingToken > first.fencingToken);
  assert.equal(await stores.coordination.isLeader("leader", first), false);
  assert.equal(await stores.coordination.release(second), true);
});
