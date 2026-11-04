# @jchaffin/voicekit-telemetry

Runtime-independent, OpenTelemetry-shaped tracing and metrics for VoiceKit. It
includes privacy-first redaction, VoiceKit operation names, release/provider
correlation, in-memory and console exporters, and an OTLP transport bridge.

```ts
import { MemoryExporter, VoiceTelemetry } from "@jchaffin/voicekit-telemetry";

const exporter = new MemoryExporter();
const telemetry = new VoiceTelemetry({
  serviceName: "voice-agent",
  provider: "openai",
  exporters: [exporter],
});

await telemetry.tracer.withSpan("voicekit.turn", async (span) => {
  span.setAttribute("voicekit.session.id", "session-1");
});
```
