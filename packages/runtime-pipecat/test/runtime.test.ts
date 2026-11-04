import test from "node:test";
import assert from "node:assert/strict";
import { emitPipecatRuntimeManifest, validatePipecatRuntimeManifest, createPipecatControlClient } from "../src/index.ts";

test("emits and validates the versioned Python manifest", () => {
  const manifest = emitPipecatRuntimeManifest({
    runtime: { python: ">=3.11", pipecat: ">=0.0.90", entrypoint: "bot:main" },
    transport: { kind: "websocket", audioInput: "pcm_s16le/16000", audioOutput: "pcm_s16le/24000" },
    capabilities: { interruption: true, tools: true, metrics: true },
  });
  assert.equal(manifest.version, "1");
  assert.equal(validatePipecatRuntimeManifest({ ...manifest, version: "2" }).ok, false);
});

test("control client emits versioned requests", async () => {
  const sent: unknown[] = [];
  const client = createPipecatControlClient({
    requestId: () => "request",
    transport: { send: async (message) => { sent.push(message); }, onMessage: () => () => {}, close: async () => {} },
  });
  await client.sendText("hello");
  assert.deepEqual(sent[0], { version: "1", id: "request", type: "input.text", text: "hello" });
});
