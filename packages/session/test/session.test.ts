import assert from "node:assert/strict";
import { InMemoryEventJournal } from "@jchaffin/voicekit-core";
import { createCommandEnvelope } from "@jchaffin/voicekit-protocol";
import {
  InvalidSessionTransitionError,
  SessionController,
} from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

test("reduces the complete happy-path session lifecycle", async () => {
  const journal = new InMemoryEventJournal();
  const session = new SessionController("session-1", journal);
  const commands = [
    { type: "session.provision", data: {} },
    { type: "session.connect", data: {} },
    { type: "session.ready", data: {} },
    { type: "session.listen", data: {} },
    { type: "session.think", data: {} },
    { type: "session.speak", data: {} },
    { type: "session.drain", data: {} },
    { type: "session.close", data: { reason: "complete" } },
  ] as const;
  for (const [index, command] of commands.entries()) {
    await session.handle(createCommandEnvelope("session-1", command, { id: `command-${index}` }));
  }
  assert.equal(session.state.phase, "closed");
  assert.equal(session.state.closedReason, "complete");
});

test("replays duplicate commands without appending", async () => {
  const session = new SessionController("session-1", new InMemoryEventJournal());
  const command = createCommandEnvelope(
    "session-1",
    { type: "session.provision", data: {} },
    { id: "stable-command" },
  );
  const first = await session.handle(command);
  const second = await session.handle(command);
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.events[0]?.id, first.events[0]?.id);
  assert.equal(session.events.length, 2);
});

test("persists accepted no-op commands for idempotent replay", async () => {
  const session = new SessionController("session-1", new InMemoryEventJournal());
  await session.handle(createCommandEnvelope(
    "session-1",
    { type: "session.provision", data: {} },
    { id: "first-provision" },
  ));
  const noOp = createCommandEnvelope(
    "session-1",
    { type: "session.provision", data: {} },
    { id: "no-op-provision" },
  );
  const first = await session.handle(noOp);
  const replay = await session.handle(noOp);
  assert.equal(first.events[0]?.event.type, "lifecycle.command_accepted");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.events[0]?.id, first.events[0]?.id);
});

test("rejects invalid transitions and aborted commands", async () => {
  const session = new SessionController("session-1", new InMemoryEventJournal());
  await assert.rejects(
    session.handle(createCommandEnvelope("session-1", { type: "session.speak", data: {} })),
    InvalidSessionTransitionError,
  );

  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(
    session.handle(
      createCommandEnvelope("session-1", { type: "session.provision", data: {} }),
      { signal: abort.signal },
    ),
    /cancelled/,
  );
  await assert.rejects(
    session.handle(createCommandEnvelope(
      "session-1",
      { type: "session.provision", data: {} },
      { deadline: "2020-01-01T00:00:00.000Z" },
    )),
    { name: "DeadlineExceededError" },
  );
});

test("captures provider-native events without changing phase", async () => {
  const session = new SessionController("session-1", new InMemoryEventJournal());
  await session.handle(createCommandEnvelope("session-1", {
    type: "provider.emit_raw",
    data: { provider: "example", eventType: "socket.message", payload: { value: 1 } },
  }));
  assert.equal(session.state.phase, "created");
  assert.equal(session.events.at(-1)?.event.type, "provider.raw");
});
