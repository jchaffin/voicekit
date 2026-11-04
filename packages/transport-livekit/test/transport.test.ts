import test from "node:test";
import assert from "node:assert/strict";
import { createLiveKitTransport, normalizeLiveKitEvent } from "../src/index.ts";

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
