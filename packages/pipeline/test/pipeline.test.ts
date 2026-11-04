import test from "node:test";
import assert from "node:assert/strict";
import { createVoicePipeline, type StageContext } from "../src/index.ts";

test("composed pipeline falls back, applies backpressure, and reports timing", async () => {
  const timings: unknown[] = [];
  const fallbacks: unknown[] = [];
  const failed = { name: "failed", transcribe: async () => { throw new Error("unavailable"); } };
  const stt = { name: "stt", transcribe: async (audio: number) => String(audio) };
  const llm = { name: "llm", generate: async (text: string) => `${text}!` };
  const tts = { name: "tts", synthesize: async (text: string) => new TextEncoder().encode(text) };
  const pipeline = createVoicePipeline({
    stt: [failed, stt],
    llm,
    tts,
    options: {
      highWaterMark: 1,
      onTiming: (timing) => timings.push(timing),
      onFallback: (event) => fallbacks.push(event),
    },
  });
  const output: string[] = [];
  for await (const chunk of pipeline.run([1, 2])) output.push(new TextDecoder().decode(chunk));
  assert.deepEqual(output, ["1!", "2!"]);
  assert.equal(timings.length, 6);
  assert.equal(fallbacks.length, 2);
});

test("aborted pipeline rejects before stages run", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let ran = false;
  const provider = { name: "one", transcribe: (_input: number, _context: StageContext) => { ran = true; return "x"; } };
  const pipeline = createVoicePipeline({
    stt: provider,
    llm: { name: "two", generate: (value: string) => value },
    tts: { name: "three", synthesize: (value: string) => value },
  });
  await assert.rejects(async () => { for await (const _ of pipeline.run([1], { signal: controller.signal })) {} });
  assert.equal(ran, false);
});
