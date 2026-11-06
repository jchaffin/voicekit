# @jchaffin/voicekit-conformance

Reusable behavioral suites for VoiceKit adapters. The contract covers connection lifecycle, normalized authentication errors, event ordering, interruption, tool deduplication, reconnect/resume, cancellation, usage, raw event escape hatches, backpressure, timeouts, and truthful capability declarations.

```ts
import { runAdapterSuites } from "@jchaffin/voicekit-conformance";

const results = await runAdapterSuites({
  createAdapter: () => myAdapter,
  validAuth: "test-token",
  invalidAuth: "known-invalid-token",
});
```

Live certification is explicit and secret-safe. Register secret *names*, never values. `runCertifications` reports the entry as skipped when any reference is absent, and only passes selected values to the fixture factory.

Alpha.1 also exports `alpha1SemanticSuites`: reusable offline contracts for GPT-Live duplex/delegation behavior, experiment reconnect/exposure/fallback idempotency, ElevenAgents native-versus-managed routing, and LiveKit named deployments. Implement `run(scenario)` on the fixture and pass these suites to `runAdapterSuites`. Passing them certifies fixture behavior only, not a provider network.
