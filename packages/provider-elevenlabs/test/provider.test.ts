import test from "node:test";
import assert from "node:assert/strict";
import {
  createElevenAgentsRouteDescriptor,
  createElevenLabsRealtimeProvider,
  createElevenLabsTTSProvider,
  defineElevenAgentsExperiment,
  elevenAgentsCustomToolVersionCaveat,
  elevenLabsCapabilities,
  normalizeElevenLabsEvent,
  readElevenAgentsAttribution,
} from "../src/index.ts";

test("declares conversational capabilities and streams injected TTS bytes", async () => {
  assert.equal(elevenLabsCapabilities.tools, true);
  const provider = createElevenLabsTTSProvider({
    token: () => "token",
    client: { async *synthesize() { yield { audio: Uint8Array.of(1, 2) }; } },
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of provider.synthesize("hello")) chunks.push(chunk);
  assert.deepEqual(chunks[0], Uint8Array.of(1, 2));
  assert.deepEqual(normalizeElevenLabsEvent({ type: "user_transcript", text: "hello" }), {
    type: "transcript", role: "user", text: "hello", isFinal: true,
  });
});

test("validates ElevenAgents experiment allocation and unique version targets", () => {
  const experiment = defineElevenAgentsExperiment({
    id: "experiment",
    agentId: "agent",
    variants: [
      { branchId: "main", versionId: "v1", percentage: 75 },
      { branchId: "candidate", versionId: "v2", percentage: 25 },
    ],
  });
  assert.equal(experiment.variants.reduce((sum, variant) => sum + variant.percentage, 0), 100);
  assert.throws(() => defineElevenAgentsExperiment({
    id: "bad",
    agentId: "agent",
    variants: [
      { branchId: "main", versionId: "v1", percentage: 80 },
      { branchId: "candidate", versionId: "v2", percentage: 10 },
    ],
  }), /total 100/);
  assert.throws(() => defineElevenAgentsExperiment({
    id: "duplicate",
    agentId: "agent",
    variants: [
      { branchId: "main", versionId: "v1", percentage: 50 },
      { branchId: "main", versionId: "v1", percentage: 50 },
    ],
  }), /unique/);
});

test("keeps provider-assigned and explicit routing distinct and records actual attribution", () => {
  const explicit = createElevenAgentsRouteDescriptor({
    kind: "webrtc-token",
    method: "POST",
    agentId: "agent",
    routing: {
      mode: "voicekit-explicit",
      agentId: "agent",
      branchId: "candidate",
      versionId: "v2",
      assignmentId: "opaque-assignment",
    },
  });
  assert.equal(explicit.routing.mode, "voicekit-explicit");
  assert.throws(() => createElevenAgentsRouteDescriptor({
    kind: "signed-url",
    method: "GET",
    agentId: "other-agent",
    routing: { mode: "provider-assigned", agentId: "agent" },
  }), /must match/);
  assert.deepEqual(readElevenAgentsAttribution({
    agent_id: "agent",
    branch_id: "actual-branch",
    version_id: "actual-version",
    assignment_id: "opaque-assignment",
  }, "provider-assigned"), {
    agentId: "agent",
    branchId: "actual-branch",
    versionId: "actual-version",
    assignmentId: "opaque-assignment",
    routingMode: "provider-assigned",
  });
});

test("standalone Eleven Realtime remains separate from ElevenAgents experiments", () => {
  const provider = createElevenLabsRealtimeProvider({
    token: () => "token",
    clientFactory: () => ({
      connect: async () => {},
      onEvent: () => {},
      send: async () => {},
      close: async () => {},
    }),
  });
  assert.equal(provider.product, "eleven-realtime");
  assert.match(elevenAgentsCustomToolVersionCaveat, /shared agent resources/);
});
