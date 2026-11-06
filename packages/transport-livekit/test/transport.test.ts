import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveKitDispatchDescriptor,
  createLiveKitTransport,
  defineLiveKitDispatch,
  normalizeLiveKitEvent,
} from "../src/index.ts";

test("transport obtains token and sends normalized data without an SDK", async () => {
  const published: Uint8Array[] = [];
  const transport = createLiveKitTransport({
    token: () => "room-token",
    providerOptions: { url: "wss://example.invalid" },
    roomFactory: async () => ({
      connect: async (_url, token) => { assert.equal(token, "room-token"); },
      onEvent: () => {},
      publishData: async (payload) => { published.push(payload); },
      disconnect: async () => {},
    }),
  });
  const session = await transport.connect();
  await session.send({ type: "ping" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(published[0])), { type: "ping" });
  assert.equal(normalizeLiveKitEvent({ type: "Reconnecting" }).type, "reconnecting");
});

test("describes API, token, and SIP explicit dispatch without SDK-specific calls", () => {
  const dispatch = defineLiveKitDispatch({
    agentName: "concierge",
    deploymentName: "blue",
    metadata: { tenant: "acme", nested: { cohort: 7 } },
    experimentAssignmentId: "opaque:assignment/123",
  });
  assert.equal(dispatch.environment, "production");
  assert.equal(dispatch.experimentAssignmentId, "opaque:assignment/123");

  const descriptors = [
    createLiveKitDispatchDescriptor({ kind: "api-dispatch", dispatch, roomName: "room" }),
    createLiveKitDispatchDescriptor({ kind: "token-dispatch", dispatch, participantIdentity: "caller" }),
    createLiveKitDispatchDescriptor({ kind: "sip-dispatch", dispatch, trunkId: "trunk" }),
  ];
  assert.deepEqual(descriptors.map(({ kind }) => kind), [
    "api-dispatch",
    "token-dispatch",
    "sip-dispatch",
  ]);
});

test("rejects missing named deployments and non-JSON metadata", () => {
  assert.throws(() => defineLiveKitDispatch({
    agentName: "concierge",
    deploymentName: "",
  }), /named deployment/);
  assert.throws(() => defineLiveKitDispatch({
    agentName: "concierge",
    deploymentName: "blue",
    metadata: { invalid: Number.NaN },
  }), /finite JSON numbers/);
});
