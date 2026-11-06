import assert from "node:assert/strict";
import {
  CertificationRegistry,
  type AdapterError,
  type AdapterUnderTest,
  type ConformanceSession,
  type NormalizedAdapterEvent,
  alpha1SemanticSuites,
  runAdapterSuites,
  runCertifications,
} from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

function adapterError(code: string, message: string, retryable: boolean): AdapterError {
  return Object.assign(new Error(message), { code, retryable });
}

function createFakeAdapter(): AdapterUnderTest {
  return {
    name: "deterministic-fake",
    capabilities: {
      interruption: true,
      tools: true,
      reconnect: true,
      cancellation: true,
      usage: true,
      rawEvents: true,
      backpressure: true,
      timeout: true,
      audioHighWaterMark: 32,
    },
    async connect(options = {}): Promise<ConformanceSession> {
      if (options.auth === "invalid") throw adapterError("AUTH_INVALID", "invalid credentials", false);
      if (options.timeoutMs === 0) throw adapterError("TIMEOUT", "connect timed out", true);
      const listeners = new Set<(event: NormalizedAdapterEvent) => void>();
      const results = new Map<string, unknown>();
      let closed = false;
      let concurrentAudioWrites = 0;
      let maxConcurrentAudioWrites = 0;
      const emit = (event: NormalizedAdapterEvent) => {
        for (const listener of listeners) listener(event);
      };
      const ensureOpen = () => {
        if (closed) throw adapterError("CLOSED", "session closed", false);
      };
      return {
        sessionId: "fake-session",
        resumeToken: "resume-fake-session",
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async sendText(text) {
          ensureOpen();
          emit({ type: "speech.start", role: "user" });
          emit({ type: "transcript", text, final: true });
          emit({ type: "speech.end", role: "user" });
          emit({ type: "raw", raw: { providerType: "unmapped" } });
        },
        async sendAudio(audio) {
          ensureOpen();
          concurrentAudioWrites += 1;
          maxConcurrentAudioWrites = Math.max(maxConcurrentAudioWrites, concurrentAudioWrites);
          try {
            await Promise.resolve();
            emit({ type: "usage", metric: "audio_input_bytes", quantity: audio.byteLength, unit: "bytes" });
          } finally {
            concurrentAudioWrites -= 1;
          }
        },
        async interrupt() { ensureOpen(); emit({ type: "interrupted" }); },
        async callTool(call) {
          ensureOpen();
          if (!results.has(call.callId)) results.set(call.callId, { echoed: call.input });
          return results.get(call.callId);
        },
        async reconnect() { ensureOpen(); emit({ type: "connected", resumed: true }); },
        async cancel(operationId) { ensureOpen(); emit({ type: "cancelled", operationId }); },
        diagnostics: () => ({ maxConcurrentAudioWrites }),
        async close() {
          if (closed) return;
          closed = true;
          emit({ type: "closed" });
        },
      };
    },
  };
}

const fixture = {
  createAdapter: async () => createFakeAdapter(),
  validAuth: "valid",
  invalidAuth: "invalid",
};

test("all reusable suites pass against deterministic fake", async () => {
  const results = await runAdapterSuites(fixture);
  assert.equal(results.length, 12);
  assert.deepEqual([...new Set(results.map((result) => result.status))], ["passed"]);
});

test("live registry skips entries whose secret references are absent", async () => {
  const registry = new CertificationRegistry().register({
    id: "fake-live",
    adapter: "deterministic-fake",
    secretReferences: ["FAKE_API_KEY"],
    createFixture: async () => fixture,
  });
  const skipped = await runCertifications(registry);
  assert.equal(skipped[0]?.status, "skipped");
  assert.match(skipped[0]?.reason ?? "", /FAKE_API_KEY/);

  const certified = await runCertifications(registry, { secrets: { FAKE_API_KEY: "test-only" } });
  assert.equal(certified[0]?.status, "passed");
});

test("alpha.1 semantic suites are reusable with deterministic fixtures", async () => {
  const semanticFixture = {
    ...fixture,
    async run(scenario: string) {
      switch (scenario) {
        case "gpt-live/full-duplex":
          return [
            { type: "listen.start", turnId: "u1" },
            { type: "speak.start", turnId: "a1" },
            { type: "listen.stop", turnId: "u1" },
          ] as const;
        case "gpt-live/delegation-idempotency":
          return [
            { type: "delegation.requested", delegationId: "d1" },
            { type: "delegation.started", delegationId: "d1" },
            { type: "delegation.completed", delegationId: "d1" },
          ] as const;
        case "gpt-live/interruption-cancellation":
          return [
            { type: "delegation.requested", delegationId: "d1" },
            { type: "delegation.started", delegationId: "d1" },
            { type: "interruption", delegationId: "d1" },
            { type: "delegation.cancelled", delegationId: "d1" },
          ] as const;
        case "experiment/reconnect":
          return [
            { type: "assignment", assignmentId: "a1", variantId: "v1", owner: "voicekit" },
            { type: "assignment", assignmentId: "a1", variantId: "v1", owner: "voicekit" },
          ] as const;
        case "experiment/exposure-idempotency":
          return [{ type: "exposure", assignmentId: "a1", exposureId: "e1" }] as const;
        case "experiment/fallback":
          return [
            { type: "assignment", assignmentId: "a1", variantId: "v1", owner: "voicekit" },
            { type: "exposure", assignmentId: "a1", exposureId: "e1", deviation: "fallback" },
          ] as const;
        case "elevenagents/native":
          return [{ type: "route", owner: "native" }] as const;
        case "elevenagents/managed":
          return [{ type: "route", owner: "voicekit", branchId: "branch-1" }] as const;
        case "livekit/named-deployment":
          return [{ type: "deployment", agentName: "concierge", deploymentName: "alpha-1", environment: "production" }] as const;
        default:
          throw new Error(`Unknown scenario: ${scenario}`);
      }
    },
  };
  const results = await runAdapterSuites(semanticFixture, alpha1SemanticSuites);
  assert.equal(results.length, 9);
  assert.ok(results.every((result) => result.status === "passed"));
});
