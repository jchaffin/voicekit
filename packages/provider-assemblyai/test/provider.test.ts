import test from "node:test";
import assert from "node:assert/strict";
import { assemblyAICapabilities, normalizeAssemblyAIEvent } from "../src/index.ts";

test("declares STT-only capability and normalizes turns", () => {
  assert.deepEqual(assemblyAICapabilities, {
    realtime: false, stt: true, llm: false, tts: false, interruption: false, tools: false,
  });
  assert.deepEqual(normalizeAssemblyAIEvent({
    type: "Turn", transcript: "hello", end_of_turn: true, end_of_turn_confidence: 0.9,
  }), {
    type: "transcript", text: "hello", isFinal: true, confidence: 0.9,
  });
});
