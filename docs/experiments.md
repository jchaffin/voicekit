# Experiments in alpha.1

VoiceKit experiments separate assignment, exposure, routing, and analysis. An assignment is a durable intent for one tenant-scoped unit. An exposure is recorded only when that unit actually reaches the treatment surface. Outcomes reference the pinned assignment.

## Lifecycle

Revisions move `draft → approved → running`, then may pause, complete, or roll back. Published revisions are immutable: change allocation, eligibility, metrics, or routing by creating another revision. Approval and operation are separate roles by default, and every transition is audited.

Assignment uses keyed HMAC bucketing over tenant, unit type, unit ID, immutable salt, and purpose. Store the HMAC key server-side. Reconnects reuse the original assignment, revision, and allocation epoch. Exposure and outcome writes require stable idempotency keys.

Provider ownership is explicit:

- `voicekit` means VoiceKit selects a variant and emits the provider routing payload.
- `native` means the provider owns its branch decision. VoiceKit retains assignment context for attribution but must not inject an explicit branch.

A fallback does not reassign the user. Record one exposure against the intended assignment with a `fallback` deviation and the actual provider. This preserves intention-to-treat analysis and permits a separate per-protocol analysis.

## Statistical safeguards

- Declare primary, secondary, and guardrail metrics before starting.
- Use one stable assignment unit; do not mix users and sessions.
- Keep salts and epoch start times immutable.
- Coordinate mutually exclusive experiments in a layer.
- Inspect sample-ratio mismatch before interpreting uplift.
- Include unexposed assignments in intention-to-treat summaries.
- Do not repeatedly inspect ordinary confidence intervals as a stopping rule. Use a predeclared fixed horizon or a valid sequential design.
- Treat provider fallback, reconnect, and missing telemetry as operational data, not reasons to silently drop units.

The built-in diagnostics are engineering safeguards, not a claim of statistical significance or a replacement for experiment review.
