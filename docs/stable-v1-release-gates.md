# Stable v1 release gates

The `1.0.0` tag is allowed only when every required gate is green on the exact release artifacts.

## API and packaging

- All v1 packages build as ESM and CommonJS, emit declarations and source maps, expose only documented entry points, and install on Node 20 without the repository.
- Public types pass strict TypeScript with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Package versions and internal dependency ranges are aligned; tarballs contain no tests, fixtures with customer data, or credentials.
- Protocol compatibility and capability negotiation are frozen and documented.

## Behavior

- Unit and deterministic simulation suites are repeatable with no wall-clock sleeps.
- Every declared adapter capability passes the full conformance suite.
- Selected live provider certifications pass in supported regions; absent optional credentials are reported as skipped, never passed.
- Reconnect, interruption, duplicate tools, cancellation, bounded backpressure, timeout, fallback, handoff rollback, and clean drain have end-to-end coverage.
- Performance budgets are met for first audio, interruption stop, memory, queue depth, and reconnect recovery.

## Operations and safety

- Preview one-shot deployment, health tests, drift inspection, promotion approval, and rollback are exercised from a clean account.
- Threat model, privacy review, dependency/license scan, credential scan, and incident runbook are approved.
- Consent, redaction, retention, deletion, tool authorization, audit records, and raw-event handling are tested.
- Telemetry has stable cardinality, no secrets, and dashboards for latency, failure, reconnect, tool, policy, and usage signals.

## Release discipline

- Migration from 0.4 is validated on representative applications and has a tested rollback.
- Provider capability documentation matches exported constants and live results.
- Changelog, support matrix, examples, and deprecation policy are complete.
- A release candidate runs in canary traffic for the agreed observation window with no unresolved critical or high-severity defects.
- Maintainers sign off on API, security, operations, documentation, and package provenance.

Skipped required gates block stable v1. Exceptions require a written owner, scope, expiry, and mitigation; an exception cannot cover protocol corruption, credential exposure, data loss, unsafe tool execution, or an untested rollback.
