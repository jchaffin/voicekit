# VoiceKit LiveKit runtime

VoiceKit protocol runtime contracts for agents hosted on LiveKit.

Explicit routing supports agent name, named deployment, JSON metadata, and an opaque experiment assignment ID. The environment defaults to `production`.

Capability metadata records the deployment constraints consumers must account for:

- minimum Agents SDK: Python `1.6.0`; Node `@livekit/agents` `1.7.1`
- non-production deployments can cold start
- redeploy disconnects current sessions immediately
- rollback is not supported
- secrets are shared
- Insights metrics are available only for production

These are declarative semantics, not fabricated SDK operations.
