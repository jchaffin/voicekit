# LiveKit named deployments

Alpha.1 carries an explicit `agentName`, `deploymentName`, environment, JSON metadata, and optional experiment assignment through transport dispatch and runtime configuration.

Use named deployment dispatch when multiple deployed versions share an agent name. Keep the descriptor as application data, then translate it at the server boundary to the installed LiveKit server SDK. API dispatch, token dispatch, and SIP dispatch have different provider request shapes; VoiceKit does not submit those network requests.

Operational caveats represented by the alpha.1 runtime contract:

- Production is the default environment; choose non-production explicitly.
- Non-production capacity may cold-start.
- A redeploy can disconnect active work; drain or schedule changes accordingly.
- Rollback is an application/deployment operation, not an in-session guarantee.
- Secrets may be shared at a broader project scope than one deployment.
- Some hosted insights apply only to production.
- SDK minimums exported by the runtime are Python 1.6.0 and `@livekit/agents` 1.7.1; verify current LiveKit release notes before deployment.

Names are routing identifiers, not immutable artifacts. Record the resolved deployment/version in telemetry when auditability matters. The conformance suite validates descriptor semantics offline; it does not claim a successful LiveKit Cloud dispatch without credentials.
