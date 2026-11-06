import assert from "node:assert/strict";
import {
  FaultyNetwork,
  DelegatedTaskSimulation,
  ExperimentFallbackSimulation,
  FullDuplexSimulation,
  SimulationJournal,
  VirtualClock,
  assertSimulation,
  firstAudioUnder,
  handoffOccurred,
  noPolicyViolations,
  replay,
  syntheticAudio,
  toolCalledOnce,
} from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

test("virtual clock is monotonic and stable for equal deadlines", () => {
  const clock = new VirtualClock(100);
  const order: number[] = [];
  clock.schedule(10, () => order.push(1));
  clock.schedule(10, () => order.push(2));
  clock.advanceBy(10);
  assert.deepEqual(order, [1, 2]);
  assert.equal(clock.now(), 110);
  assert.throws(() => clock.advanceTo(109), /backwards/);
});

test("synthetic audio and deterministic network faults are repeatable", () => {
  assert.deepEqual(syntheticAudio({ durationMs: 40 }), syntheticAudio({ durationMs: 40 }));
  const clock = new VirtualClock();
  const network = new FaultyNetwork<string>(clock, { latencyMs: 10, jitterMs: 2, lossEvery: 2 });
  const received: string[] = [];
  assert.equal(network.send("one", (value) => received.push(value)), "scheduled");
  assert.equal(network.send("two", (value) => received.push(value)), "lost");
  clock.runAll();
  assert.deepEqual(received, ["one"]);
});

test("journal assertions and replay preserve order", () => {
  const clock = new VirtualClock();
  const journal = new SimulationJournal(clock, "call-1");
  journal.append({ type: "turn.started", data: { turnId: "u1", participant: "user" } });
  clock.advanceBy(25);
  journal.append({
    type: "media.frame",
    data: { streamId: "output-main", sequence: 1, timestampMs: 25, payload: "", encoding: "base64" },
  });
  journal.append({ type: "tool.call_started", data: { callId: "t1", name: "lookup", arguments: {} } });
  journal.append({ type: "handoff.completed", data: { handoffId: "h1", target: "human" } });
  const snapshot = journal.snapshot("complete");
  assertSimulation(snapshot.events, firstAudioUnder(50), toolCalledOnce("lookup"), handoffOccurred("human"), noPolicyViolations());

  const replayClock = new VirtualClock();
  const seen: number[] = [];
  replay(snapshot, replayClock, { onEvent: (event) => { seen.push(event.sequence); } });
  replayClock.runAll();
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test("full-duplex simulation permits overlapping listen and speak", () => {
  const clock = new VirtualClock();
  const duplex = new FullDuplexSimulation(clock);
  duplex.set("listening", true, "user-1");
  clock.advanceBy(20);
  duplex.set("speaking", true, "agent-1");
  assert.equal(duplex.overlapping, true);
  clock.advanceBy(30);
  duplex.set("listening", false, "user-1");
  assert.equal(duplex.overlapping, false);
  assert.deepEqual(duplex.transitions().map((event) => event.atMs), [0, 20, 50]);
});

test("delegated task interruption follows cancellation policy idempotently", () => {
  const clock = new VirtualClock();
  const tasks = new DelegatedTaskSimulation(clock);
  tasks.start("continue");
  assert.equal(tasks.interrupt("continue", "continue")?.state, "running");
  tasks.start("cancel");
  clock.advanceBy(25);
  const cancelled = tasks.interrupt("cancel", "cancel");
  assert.equal(cancelled?.state, "cancelled");
  assert.equal(cancelled?.cancellationReason, "voice_interrupted");
  assert.equal(tasks.complete("cancel"), cancelled);
  assert.equal(tasks.cancel("cancel"), cancelled);
});

test("experiment fallback preserves assignment and deduplicates exposure", () => {
  const fallbacks = new ExperimentFallbackSimulation();
  const first = fallbacks.record({
    assignmentId: "assignment-1",
    intendedVariantId: "gpt-live",
    actualProvider: "livekit",
    exposureId: "call-1",
    fallback: true,
  });
  const retry = fallbacks.record({ ...first, actualProvider: "elevenagents" });
  assert.equal(retry, first);
  assert.deepEqual(fallbacks.read(), [first]);
});
