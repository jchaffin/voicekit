import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIRealtimeProvider } from "../src/index.ts";

test("realtime provider authenticates, maps events, interrupts and closes", async () => {
  let listener: (event: unknown) => void = () => {};
  const sent: unknown[] = [];
  let interrupted = false;
  let closed = false;
  const provider = createOpenAIRealtimeProvider({
    token: async () => "ephemeral",
    clientFactory: async ({ token }) => {
      assert.equal(token, "ephemeral");
      return {
        connect: async () => {},
        onEvent: (next) => { listener = next; },
        send: async (event) => { sent.push(event); },
        interrupt: async () => { interrupted = true; },
        close: async () => { closed = true; },
      };
    },
  });
  const session = await provider.connect();
  const events: unknown[] = [];
  session.onEvent((event) => events.push(event));
  listener({ type: "response.output_text.delta", delta: "hi", item_id: "a" });
  await session.sendText("hello");
  await session.interrupt();
  await session.close();
  assert.equal((events[0] as { type: string }).type, "transcript.delta");
  assert.deepEqual(sent[0], { type: "input_text", text: "hello" });
  assert.equal(interrupted, true);
  assert.equal(closed, true);
});
