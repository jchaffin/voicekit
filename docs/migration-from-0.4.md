# Migrating from VoiceKit 0.4

Version 1 replaces the root-package, React-first API with composable packages and a protocol-first kernel. Migrate one call path at a time; do not mix legacy and v1 events in one journal.

1. Replace root imports with explicit packages. Session state comes from `@jchaffin/voicekit-session`; protocol types from `voicekit-protocol`; provider, transport, runtime, pipeline, policy, tools, graph, persistence, telemetry, UI, and React bindings are separate dependencies.
2. Replace provider constructors that read environment variables with injected token functions and SDK client factories. Keep tokens on the server and retain `raw` only for controlled provider-specific behavior.
3. Convert callbacks into normalized v1 events. Persist `EventEnvelope` objects with protocol version, session ID, monotonically increasing sequence, timestamp, and causation metadata.
4. Move state changes into `SessionController` commands. Do not assign connection or speaking state directly. Use stable command IDs so retries are idempotent.
5. Choose a media architecture explicitly: native S2S, cascaded pipeline, or hosted runtime. A transport does not imply model capability.
6. Replace ad hoc function calls with typed tool definitions, policy evaluation, scopes, timeout, abort propagation, and idempotency keys.
7. Replace agent switching with graph handoffs. Freeze, drain, project minimal context, initialize, and commit atomically.
8. Add deterministic simulations and adapter conformance before switching traffic.
9. Define deployment resources with secret references, preview gates, a durable ledger, and rollback.

Behavior changes to expect: close is idempotent; sends after close reject; interruption and cancellation are explicit; capability absence is not emulated; raw provider events are escape hatches rather than the main API; session replay never invokes providers or policy; bounded queues can apply backpressure; deadlines and aborts surface as errors rather than silent completion.

Run both systems against synthetic calls, compare normalized journals and latency assertions, then canary v1 by tenant or route. Keep a rollback path until v1 meets all release gates and historical 0.4 sessions have drained.
