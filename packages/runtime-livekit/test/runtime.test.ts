import test from "node:test";
import assert from "node:assert/strict";
import { createLiveKitRuntime } from "../src/index.ts";

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
