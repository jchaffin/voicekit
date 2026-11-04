import test from "node:test";
import assert from "node:assert/strict";
import { createElevenLabsTTSProvider, elevenLabsCapabilities, normalizeElevenLabsEvent } from "../src/index.ts";

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
