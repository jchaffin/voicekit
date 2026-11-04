# Privacy and security

Voice is sensitive biometric and conversational data. Minimize collection before optimizing model quality.

Use short-lived, audience-scoped tokens minted by a trusted server. Browser and mobile clients must never receive long-lived provider keys. Token functions should honor `AbortSignal`, and logs must contain secret reference names only. Validate inbound webhook signatures and authorize every session, tool, handoff, replay, and journal read.

Obtain explicit recording and processing consent before opening media. Keep consent in policy context and emit an auditable decision. Separate live media from durable normalized events; do not persist audio or transcript text by default. Apply redaction before telemetry or storage, cap retention with policy, encrypt retained data, and make deletion operate across journals, blobs, traces, backups, and provider copies.

Tools are the primary side-effect boundary. Validate typed input and output, allowlist tools per agent, scope credentials per tool, require approval for sensitive writes, use idempotency keys, set deadlines, and propagate cancellation. Never trust model-provided call IDs as authorization. Handoffs must project the minimum context and re-evaluate policy for the target.

For network and runtime safety, use TLS, origin restrictions, bounded audio queues, payload limits, timeouts, reconnect limits, and denial-of-service controls. Treat `provider.raw` payloads as untrusted and potentially sensitive. Scrub error messages before exposing them to clients.

Simulation fixtures must be synthetic or explicitly licensed and de-identified. Live conformance reads secrets by reference and skips when absent; do not weaken this behavior in CI. Restrict replay access because a normalized journal can still reveal customer intent and tool results.

Before launch, document data processors, regions, retention, incident response, lawful basis, user deletion, and recording disclosures for every supported jurisdiction. VoiceKit supplies enforcement points, not legal compliance by itself.
