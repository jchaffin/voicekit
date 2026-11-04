import assert from "node:assert/strict";
import {
  CapabilityNegotiationError,
  VOICEKIT_PROTOCOL_VERSION,
  createCommandEnvelope,
  negotiateCapabilities,
} from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

test("negotiates matching required capabilities", () => {
  const result = negotiateCapabilities(
    {
      protocolVersions: [VOICEKIT_PROTOCOL_VERSION],
      capabilities: [{ name: "audio/pcm", version: "1", required: true }],
    },
    {
      protocolVersions: [VOICEKIT_PROTOCOL_VERSION],
      capabilities: [{ name: "audio/pcm", version: "1" }],
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.capabilities[0]?.name, "audio/pcm");
});

test("returns an explicit capability mismatch error", () => {
  const result = negotiateCapabilities(
    {
      protocolVersions: [VOICEKIT_PROTOCOL_VERSION],
      capabilities: [{ name: "audio/pcm", version: "1", required: true }],
    },
    {
      protocolVersions: [VOICEKIT_PROTOCOL_VERSION],
      capabilities: [{ name: "audio/pcm", version: "2" }],
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof CapabilityNegotiationError);
    assert.equal(result.error.code, "CAPABILITY_VERSION_MISMATCH");
  }
});

test("creates versioned command envelopes", () => {
  const envelope = createCommandEnvelope(
    "session-1",
    { type: "session.connect", data: {} },
    { id: "command-1", timestamp: "2026-01-01T00:00:00.000Z" },
  );
  assert.equal(envelope.protocolVersion, VOICEKIT_PROTOCOL_VERSION);
  assert.equal(envelope.id, "command-1");
});
