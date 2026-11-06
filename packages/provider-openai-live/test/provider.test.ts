import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_LIVE_ENDPOINT,
  OPENAI_LIVE_MODEL,
  createOpenAILiveController,
  normalizeOpenAILiveServerEvent,
  openAILiveCapabilities,
  type OpenAILiveAdapterEvent,
  type OpenAILiveClientEvent,
  type OpenAILiveSessionCreateRequest,
  type OpenAILiveTransport,
} from "../src/index.ts";

function createHarness() {
  let listener: (event: unknown) => void = () => {};
  const requests: OpenAILiveSessionCreateRequest[] = [];
  const sent: OpenAILiveClientEvent[] = [];
  let closeCount = 0;
  const transport: OpenAILiveTransport = {
    descriptor: {
      kind: "webrtc",
      sessionId: "sess_1",
      answerSdp: "answer",
      callId: "rtc_1",
      sideband: { kind: "sideband", sessionId: "sess_1", url: "wss://api.openai.test/v1/live/sess_1" },
    },
    send: async (event) => { sent.push(event); },
    close: async () => { closeCount += 1; },
    onEvent: (next) => {
      listener = next;
      return () => { listener = () => {}; };
    },
  };
  return {
    requests,
    sent,
    emit: (event: unknown) => listener(event),
    closeCount: () => closeCount,
    client: {
      createSession: async (request: OpenAILiveSessionCreateRequest) => {
        requests.push(request);
        return transport;
      },
    },
  };
}

function packageEvents(events: OpenAILiveAdapterEvent[]) {
  return events.filter((event) => event.kind === "openai.live").map((event) => event.event);
}

test("declares GPT-Live capabilities and creates a fixed responses session", async () => {
  const harness = createHarness();
  const controller = createOpenAILiveController({
    client: harness.client,
    options: {
      backend: {
        type: "responses",
        model: "gpt-6-luna",
        instructions: "Use backend rules.",
        serviceTier: "priority",
      },
      instructions: "Speak briefly and delegate account work.",
      voice: "marin",
    },
    idFactory: (() => {
      let id = 0;
      return () => `id_${++id}`;
    })(),
  });

  const descriptor = await controller.start({ kind: "webrtc", offerSdp: "offer" });
  assert.equal(descriptor.kind, "webrtc");
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.endpoint, OPENAI_LIVE_ENDPOINT);
  assert.equal(harness.requests[0]?.session.model, OPENAI_LIVE_MODEL);
  assert.deepEqual(harness.requests[0]?.session.delegation, {
    type: "responses",
    responses: {
      model: "gpt-6-luna",
      instructions: "Use backend rules.",
      serviceTier: "priority",
    },
  });
  assert.ok(openAILiveCapabilities.capabilities.some((capability) => capability.name === "voice.full_duplex"));
  assert.ok(openAILiveCapabilities.capabilities.some((capability) => capability.name === "transport.sideband"));
});

test("maps lifecycle, duplex speech, transcripts and cumulative duration idempotently", async () => {
  const harness = createHarness();
  const events: OpenAILiveAdapterEvent[] = [];
  const controller = createOpenAILiveController({
    client: harness.client,
    options: { backend: { type: "client", agent: "orders-agent", model: "custom-model" } },
    idFactory: (() => {
      let id = 0;
      return () => `generated_${++id}`;
    })(),
    now: () => new Date("2026-11-05T00:00:00.000Z"),
  });
  controller.onEvent((event) => events.push(event));
  await controller.start({ kind: "websocket" });

  const started = {
    type: "session.started",
    event_id: "evt_started",
    session: { id: "sess_1", model: "gpt-live-1" },
  };
  harness.emit(started);
  harness.emit(started);
  harness.emit({ type: "session.input_audio.speech_started", event_id: "evt_in_1", item_id: "turn_u" });
  harness.emit({
    type: "session.input_transcript.delta",
    event_id: "evt_tx_1",
    item_id: "turn_u",
    delta: "Thursday, not Friday",
    start_ms: 10,
    end_ms: 400,
  });
  harness.emit({ type: "session.output_audio.started", event_id: "evt_out_1", item_id: "turn_a" });
  harness.emit({ type: "session.usage.updated", event_id: "evt_usage_1", usage: { seconds: 12 } });
  harness.emit({ type: "session.usage.updated", event_id: "evt_usage_old", usage: { seconds: 10 } });
  harness.emit({
    type: "session.closed",
    event_id: "evt_closed",
    reason: "close_requested",
    usage: { seconds: 15 },
  });

  const emitted = packageEvents(events);
  assert.equal(emitted.filter((event) => event.type === "session.started").length, 1);
  assert.ok(emitted.some((event) => event.type === "voice.listening" && event.active));
  assert.ok(emitted.some((event) => event.type === "voice.speaking" && event.active));
  assert.deepEqual(
    emitted.filter((event) => event.type === "usage").map((event) => event.voiceSeconds),
    [12, 15],
  );
  assert.ok(emitted.some((event) =>
    event.type === "session.closed" && event.finalUsageConfirmed && event.clean,
  ));
  assert.equal(controller.state, "closed");
  assert.equal(harness.closeCount(), 1);

  const canonical = events.filter((event) => event.kind === "voicekit");
  assert.ok(canonical.some((event) => event.envelope.event.type === "transcript.partial"));
  assert.ok(canonical.every((event, index) => event.envelope.sequence === index));
});

test("tracks Responses delegation, tools, confirmations and backend usage", async () => {
  const harness = createHarness();
  const events: OpenAILiveAdapterEvent[] = [];
  const controller = createOpenAILiveController({
    client: harness.client,
    options: { backend: { type: "responses", model: "gpt-6-luna" } },
    idFactory: () => "generated",
  });
  controller.onEvent((event) => events.push(event));
  await controller.start({ kind: "sip", callId: "call_1" });
  harness.emit({ type: "session.started", event_id: "started", session: { id: "sess_1" } });
  harness.emit({
    type: "session.delegation.created",
    event_id: "delegated",
    delegation: { id: "del_1", target: "responses" },
    response_id: "resp_1",
  });
  harness.emit({
    type: "response.event",
    event_id: "tool",
    delegation_id: "del_1",
    event: {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_7", name: "lookup_order", arguments: "{\"id\":\"A42\"}" },
    },
  });
  harness.emit({
    type: "response.event",
    event_id: "approval",
    delegation_id: "del_1",
    event: {
      type: "response.output_item.done",
      item: { type: "mcp_approval_request", id: "approval_1", name: "refund_order" },
    },
  });

  await controller.submitToolResult("call_7", { status: "shipped" });
  await controller.submitConfirmation("approval_1", true);
  harness.emit({
    type: "response.event",
    event_id: "completed",
    delegation_id: "del_1",
    event: {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
    },
  });
  harness.emit({
    type: "response.event",
    event_id: "completed_duplicate_semantics",
    delegation_id: "del_1",
    event: { type: "response.completed", response: { id: "resp_1" } },
  });

  const emitted = packageEvents(events);
  assert.equal(emitted.filter((event) => event.type === "delegation.requested").length, 1);
  assert.equal(emitted.filter((event) => event.type === "delegation.completed").length, 1);
  assert.ok(emitted.some((event) => event.type === "tool.requested" && event.callId === "call_7"));
  assert.ok(emitted.some((event) =>
    event.type === "confirmation.requested" && event.requestId === "approval_1",
  ));
  assert.ok(emitted.some((event) =>
    event.type === "backend.usage" && event.usage.cachedInputTokens === 80,
  ));
  assert.deepEqual(harness.sent.map((event) => event.type), [
    "response.item.create",
    "response.create",
    "response.item.create",
    "response.create",
  ]);
});

test("client executor receives transcript context and explicit cancellation policy", async () => {
  const harness = createHarness();
  const events: OpenAILiveAdapterEvent[] = [];
  let observedAbort = false;
  const controller = createOpenAILiveController({
    client: harness.client,
    options: {
      backend: { type: "client", agent: "external-agent" },
      cancellation: { onInterruption: "cancel", onSessionClose: "detach" },
    },
    clientExecutor: {
      execute: async ({ signal, transcripts }) => {
        assert.equal(transcripts[0]?.text, "Please update it");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return {};
      },
    },
    idFactory: (() => {
      let id = 0;
      return () => `generated_${++id}`;
    })(),
  });
  controller.onEvent((event) => events.push(event));
  await controller.start({ kind: "websocket" });
  harness.emit({ type: "session.started", event_id: "started", session: { id: "sess_1" } });
  harness.emit({
    type: "session.input_transcript.delta",
    event_id: "transcript",
    item_id: "turn_1",
    delta: "Please update it",
  });
  harness.emit({
    type: "session.delegation.created",
    event_id: "delegation",
    delegation: { id: "del_client", target: "client" },
  });
  await Promise.resolve();
  harness.emit({
    type: "session.output_audio.interrupted",
    event_id: "interrupted",
    item_id: "turn_agent",
    by: "user",
  });
  await Promise.resolve();

  assert.equal(observedAbort, true);
  assert.ok(packageEvents(events).some((event) =>
    event.type === "interruption" && event.cancelledDelegations.includes("del_client"),
  ));
  assert.equal(controller.cancelDelegation("del_client"), false);
});

test("normalizer preserves unknown events and creates stable fallback ids", () => {
  const first = normalizeOpenAILiveServerEvent({ type: "future.event", value: 1 });
  const second = normalizeOpenAILiveServerEvent({ type: "future.event", value: 1 });
  assert.equal(first.type, "unknown");
  assert.equal(first.eventId, second.eventId);
});
