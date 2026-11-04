import test from "node:test";
import assert from "node:assert/strict";
import { createDeepgramSTTProvider, deepgramCapabilities } from "../src/index.ts";

test("STT contract uses injected connection and closes cleanly", async () => {
  let listener: (event: unknown) => void = () => {};
  const audio: Uint8Array[] = [];
  let finished = false;
  const provider = createDeepgramSTTProvider({
    token: () => "token",
    connectionFactory: async () => ({
      send: async (chunk) => { audio.push(chunk); },
      onEvent: (next) => { listener = next; },
      finish: async () => { finished = true; },
    }),
  });
  const stream = await provider.open();
  const events: unknown[] = [];
  stream.onEvent((event) => events.push(event));
  listener({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "hi" }] } });
  await stream.write(Uint8Array.of(3));
  await stream.close();
  assert.equal(deepgramCapabilities.llm, false);
  assert.equal((events[0] as { text: string }).text, "hi");
  assert.deepEqual(audio[0], Uint8Array.of(3));
  assert.equal(finished, true);
});
