import assert from "node:assert/strict";
import test from "node:test";
import { MemoryExporter, OtlpExporter, VoiceMetric, VoiceTelemetry } from "../dist/index.js";

test("records correlated, redacted spans and metrics", async () => {
  const exporter = new MemoryExporter();
  let now = 100;
  const telemetry = new VoiceTelemetry({
    serviceName: "agent",
    release: "r42",
    provider: "acme",
    exporters: [exporter],
    clock: () => now,
    randomId: (bytes) => "a".repeat(bytes * 2),
  });
  const parent = telemetry.start("session", { attributes: { "user.email": "private@example.com" } });
  now = 110;
  const child = telemetry.start("turn", { parent: parent.context });
  child.end();
  parent.end();
  telemetry.meter.createCounter(VoiceMetric.turns).add(1, { "transcript.text": "secret" });
  await telemetry.forceFlush();

  assert.equal(exporter.spans.length, 2);
  assert.equal(exporter.spans[0].context.traceId, exporter.spans[1].context.traceId);
  assert.equal(exporter.spans[1].attributes["user.email"], "[REDACTED]");
  assert.equal(exporter.metrics[0].attributes["transcript.text"], "[REDACTED]");
  assert.equal(exporter.spans[1].resource["voicekit.release"], "r42");
});

test("OTLP exporter separates trace and metric signals", async () => {
  const sent = [];
  const exporter = new OtlpExporter({ send: async (signal, payload) => sent.push([signal, payload]) });
  await exporter.export({
    spans: [],
    metrics: [{
      name: "count", type: "counter", value: 1, time: 1, attributes: {},
      resource: { "service.name": "test" }, instrumentationScope: { name: "test" },
    }],
  });
  assert.deepEqual(sent.map(([signal]) => signal), ["metrics"]);
});
