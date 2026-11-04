import test from "node:test";
import assert from "node:assert/strict";
import { createCartesiaTTSProvider } from "../src/index.ts";

test("context supports synthesis and interruption through injected client", async () => {
  const sent: unknown[] = [];
  let cancelled = false;
  const provider = createCartesiaTTSProvider({
    token: () => "token",
    providerOptions: { voiceId: "voice" },
    contextFactory: async () => ({
      send: async (message) => { sent.push(message); },
      onEvent: () => {},
      cancel: async () => { cancelled = true; },
      close: async () => {},
    }),
  });
  const context = await provider.open();
  await context.synthesize("hello");
  await context.interrupt();
  assert.equal((sent[0] as { transcript: string }).transcript, "hello");
  assert.equal(cancelled, true);
});
