import assert from "node:assert/strict";
import { InMemoryEventJournal, OptimisticSequenceError } from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

test("appends in session order and enforces optimistic sequences", () => {
  const journal = new InMemoryEventJournal();
  const first = journal.append(
    "session-1",
    { type: "lifecycle.session_created", data: {} },
    { expectedSequence: 0 },
  );
  assert.equal(first.sequence, 1);
  assert.throws(
    () => journal.append(
      "session-1",
      { type: "lifecycle.phase_changed", data: { from: "created", to: "provisioning" } },
      { expectedSequence: 0 },
    ),
    OptimisticSequenceError,
  );
});

test("filters subscriptions and unsubscribes on abort", () => {
  const journal = new InMemoryEventJournal();
  const controller = new AbortController();
  const seen: number[] = [];
  journal.subscribe(
    (event) => seen.push(event.sequence),
    { sessionId: "session-1", signal: controller.signal },
  );
  journal.append("other", { type: "lifecycle.session_created", data: {} });
  journal.append("session-1", { type: "lifecycle.session_created", data: {} });
  controller.abort();
  journal.append(
    "session-1",
    { type: "lifecycle.phase_changed", data: { from: "created", to: "provisioning" } },
  );
  assert.deepEqual(seen, [1]);
});
