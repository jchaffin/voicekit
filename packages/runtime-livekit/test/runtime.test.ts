import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveKitRuntime,
  defineLiveKitRuntimeDeployment,
  liveKitAgentSdkMinimums,
  liveKitDeploymentSemantics,
} from "../src/index.ts";

test("runtime executes tool calls over a separate transport contract", async () => {
  let listener: (event: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const runtime = createLiveKitRuntime({
    transport: {
      send: async (message) => { sent.push(message); },
      onEvent: (next) => { listener = next; return () => {}; },
      close: async () => {},
    },
    tools: [{ name: "sum", execute: (input) => Number((input as { a: number }).a) + 1 }],
  });
  listener({
    type: "data",
    payload: new TextEncoder().encode(JSON.stringify({
      voicekit: "1", type: "tool.call", id: "call", name: "sum", input: { a: 1 },
    })),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0]?.type, "tool.result");
  assert.equal(sent[0]?.output, 2);
  assert.equal(runtime.capabilities.transport, "livekit");
});

test("models current LiveKit deployment lifecycle and minimum agent SDKs", () => {
  assert.deepEqual(liveKitAgentSdkMinimums, {
    python: "1.6.0",
    node: "1.7.1",
    nodePackage: "@livekit/agents",
  });
  assert.equal(liveKitDeploymentSemantics.defaultEnvironment, "production");
  assert.equal(liveKitDeploymentSemantics.nonProductionColdStart, true);
  assert.equal(liveKitDeploymentSemantics.redeployBehavior, "disconnect-immediately");
  assert.equal(liveKitDeploymentSemantics.rollbackSupported, false);
  assert.equal(liveKitDeploymentSemantics.secretsScope, "shared");
  assert.equal(liveKitDeploymentSemantics.insightsMetrics, "production-only");
});

test("carries named deployment metadata and opaque assignment through runtime routing", async () => {
  const deployment = defineLiveKitRuntimeDeployment({
    agentName: "concierge",
    deploymentName: "green",
    metadata: { tenant: "acme", experiment: { arm: "b" } },
    experimentAssignmentId: "opaque:assignment/123",
  });
  assert.equal(deployment.environment, "production");

  const sent: Record<string, unknown>[] = [];
  const runtime = createLiveKitRuntime({
    transport: {
      send: async (message) => { sent.push(message); },
      onEvent: () => () => {},
      close: async () => {},
    },
    providerOptions: {
      agentName: deployment.agentName,
      deploymentName: deployment.deploymentName,
      environment: deployment.environment,
      metadata: deployment.metadata,
      experimentAssignmentId: deployment.experimentAssignmentId,
    },
  });
  await runtime.start();
  assert.deepEqual(sent[0]?.agent, {
    name: "concierge",
    deployment: "green",
    environment: "production",
    metadata: { tenant: "acme", experiment: { arm: "b" } },
    experimentAssignmentId: "opaque:assignment/123",
    instructions: undefined,
  });
});

test("rejects non-JSON runtime metadata", () => {
  assert.throws(() => defineLiveKitRuntimeDeployment({
    agentName: "concierge",
    deploymentName: "green",
    metadata: { invalid: Number.POSITIVE_INFINITY },
  }), /finite JSON numbers/);
});
