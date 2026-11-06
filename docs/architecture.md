# VoiceKit v1 architecture

VoiceKit v1 is a set of narrow packages connected by a normalized protocol, not a single runtime. Applications choose a transport, either a native speech-to-speech provider or a cascaded STT → model → TTS pipeline, an optional hosted runtime, and independent policy, tool, persistence, telemetry, deployment, simulation, and conformance layers.

## Control and data flow

The protocol package owns versioned commands, normalized events, capability negotiation, and JSON-safe envelopes. The core journal assigns per-session sequence numbers and enforces optimistic append order. The session controller validates lifecycle transitions and makes commands idempotent by causation ID. Audio remains on the selected media transport; control events and durable business facts enter the journal.

Provider packages are dependency-injection boundaries. VoiceKit does not construct vendor SDK clients or read process environment variables. An application supplies token functions and client factories, which keeps credentials server-side and makes adapters testable. Every adapter exposes normalized events plus `raw` access for provider-specific escape hatches.

Alpha.1 adds two explicit control planes. GPT-Live keeps duplex voice state independent from delegated backend-task state, so interruption need not cancel work. Experiments pin a tenant-scoped assignment before provider routing, record exposure separately, and preserve the intended assignment when fallback changes the actual provider.

The pipeline package composes STT, LLM, and TTS stages with abort propagation, bounded queues, stage timing, and ordered fallback. Native S2S providers bypass that pipeline but still normalize connection, transcript, audio, interruption, and tool events. Runtime packages connect transports to hosted agents. The graph package coordinates atomic handoffs; the policy package evaluates admission and action decisions; neither owns the session state machine.

## Determinism and certification

`@jchaffin/voicekit-simulation` supplies a monotonic virtual clock, synthetic PCM, scripted callers, deterministic providers, fault injection, snapshots, assertions, and replay. Tests advance time explicitly, so failures do not depend on timer scheduling.

`@jchaffin/voicekit-conformance` defines the minimum observable adapter contract. Deterministic suites run in every adapter build. Live certifications are registry entries with secret *references*; absent references produce a skip rather than a false failure.

The alpha.1 semantic suites cover GPT-Live overlap and delegation terminals, experiment reconnect/exposure/fallback idempotency, ElevenAgents routing ownership, and LiveKit named deployment descriptors. These are offline contract checks, not network certification.

## Package boundaries

- Protocol and core are stable kernel dependencies.
- Session owns lifecycle validity and replay-derived state.
- Providers and transports translate external SDK behavior.
- Runtime and pipeline packages execute media workloads.
- Tools and policy authorize side effects.
- Graph coordinates agent ownership changes.
- Persistence and telemetry consume normalized envelopes.
- Deploy plans provider resources without embedding secret values.
- Simulation verifies applications; conformance verifies adapters.

Applications should depend on the smallest set of packages they use. No package may require importing the legacy root package.
