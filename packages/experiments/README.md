# @jchaffin/voicekit-experiments

Provider-neutral, server-side A/B/n experimentation for VoiceKit. The package supplies deterministic assignment, immutable revision manifests, routing payloads, an idempotent ledger, lifecycle controls, and conservative intention-to-treat reporting.

## Install

```sh
npm install @jchaffin/voicekit-experiments
```

Node.js 20 or newer is required.

## Assignment

```ts
import {
  ExperimentAssigner,
  InMemoryAssignmentStore,
  type ExperimentRevision,
} from "@jchaffin/voicekit-experiments";

const store = new InMemoryAssignmentStore();
const assigner = new ExperimentAssigner(store, process.env.EXPERIMENT_HMAC_SECRET!);

const revision: ExperimentRevision = {
  experimentId: "agent-prompt",
  revision: 1,
  status: "running",
  salt: "agent-prompt-v1",
  assignmentUnitType: "user",
  eligibility: { op: "eq", attribute: "plan", value: "pro" },
  variants: [
    {
      id: "control",
      control: true,
      weight: 1,
      routing: {
        provider: "openai",
        api: "realtime",
        session: { model: "gpt-realtime" },
      },
    },
    {
      id: "candidate",
      weight: 1,
      routing: {
        provider: "livekit",
        agentName: "candidate-agent",
        deploymentId: "deployment-42",
      },
    },
  ],
  allocationEpochs: [
    { id: "1-percent", startsAt: "2026-01-01T00:00:00Z", allocation: 0.01 },
    { id: "10-percent", startsAt: "2026-01-03T00:00:00Z", allocation: 0.1 },
  ],
  metrics: [{ id: "resolved", kind: "binary", role: "primary" }],
  createdAt: new Date().toISOString(),
  createdBy: "user_123",
};

const decision = await assigner.assign(revision, {
  type: "user",
  id: "user_456",
  tenantId: "tenant_abc",
  attributes: { plan: "pro" },
});
```

Assignments use HMAC-SHA256 over length-delimited, purpose-separated inputs containing the salt, tenant, assignment-unit type, and assignment-unit ID. Keep the HMAC secret server-side and stable. Tenants cannot collide, and allocation, holdout, layer, and variant draws are independent.

The store is checked before bucketing. Once assigned, a unit remains pinned to its original revision, epoch, and variant across allocation changes, reconnects, and new revisions. `InMemoryAssignmentStore` is atomic within one process and is intended for tests or single-process services. A distributed implementation must provide transactional compare-and-set assignment and unique idempotency-key semantics.

## Allocation, layers, and holdouts

- Allocation epochs only admit new units; they do not rebucket existing assignments.
- Variant weights can change per epoch.
- Holdouts are deterministic and evaluated before allocation.
- Use `assignLayer()` with all experiments in a layer to guarantee at most one assignment. `layerAllocation` is a relative experiment weight in that coordinator.
- Direct `assign()` can enforce a standalone layer gate, but cannot coordinate mutual exclusion across independently evaluated experiments.

## Routing and deviations

`createRoutingPayload()` supports:

- ElevenAgents branch IDs and conversation configuration overrides.
- LiveKit agent names, deployment IDs, and metadata.
- OpenAI GPT-Live or Realtime session configuration.
- Pipecat agent and request body configuration.

An assignment declares `routingOwner: "voicekit" | "native"`. `resolveRouting()` emits a provider payload only for VoiceKit-owned routing; native ownership receives assignment context for the provider's own router.

Reconnects reuse the stored assignment. If execution falls back to another provider or route, do not rewrite the assignment. Record an exposure with a `deviation`; analysis remains intention-to-treat while operational reports can identify routing failures.

## Ledger and metrics

Assignment creation and its ledger event are atomic. Exposure and outcome writes are idempotent by caller-provided keys. Supported metrics are binary, count, duration, and currency; metric definitions can mark primary, secondary, or guardrail metrics.

`summarizeIntentionToTreat()` divides outcomes by all assigned units, including units with no observed outcome. `diagnoseSampleRatioMismatch()` returns observed/expected counts, Pearson's chi-square statistic, and heuristic operational severity. It intentionally does **not** claim statistical significance, confidence, or causal certainty.

## Lifecycle and approvals

`ExperimentLifecycle` enforces:

```text
draft → approved → running ⇄ paused → completed → rolled_back
                         └────────────→ rolled_back
```

Every create or transition records an audit entry. `RoleApprovalHook` provides basic RBAC, and the `ApprovalHook` interface supports policy engines or external approval systems. Revision configuration is frozen after creation; create the next numbered revision to change allocation, eligibility, variants, routing, or metrics.

## Production notes

- Store the HMAC secret in a secret manager and rotate only with an explicit migration plan.
- Use an authoritative UTC clock.
- Never include raw secrets or sensitive user attributes in manifests, routing metadata, or ledger metadata.
- Back `AssignmentStore` with transactions and unique indexes in multi-process deployments.
- Keep assignment and exposure separate: assignment indicates intent; exposure indicates delivery.
- Validate metric instrumentation and SRM diagnostics before interpreting results.
