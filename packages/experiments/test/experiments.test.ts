import assert from "node:assert/strict";
import {
  ExperimentAssigner,
  ExperimentLifecycle,
  InMemoryAssignmentStore,
  RoleApprovalHook,
  createRoutingPayload,
  diagnoseSampleRatioMismatch,
  hmacFraction,
  resolveRouting,
  summarizeIntentionToTreat,
  type Assignment,
  type ExperimentRevision,
  type LedgerEvent,
} from "../src/index.js";

const test: typeof import("node:test") = (await import(["node", "test"].join(":"))).test;

const started = "2026-01-01T00:00:00.000Z";

function revision(overrides: Partial<ExperimentRevision> = {}): ExperimentRevision {
  return {
    experimentId: "latency-test",
    revision: 1,
    status: "running",
    salt: "immutable-salt-v1",
    assignmentUnitType: "user",
    eligibility: { op: "eq", attribute: "country", value: "US" },
    variants: [
      { id: "control", weight: 1, control: true, routing: { provider: "openai", api: "realtime", session: { model: "gpt-realtime" } } },
      { id: "treatment", weight: 3, routing: { provider: "livekit", agentName: "fast-agent", deploymentId: "dep-1", metadata: { region: "us" } } },
    ],
    allocationEpochs: [{ id: "epoch-1", startsAt: started, allocation: 1 }],
    metrics: [
      { id: "converted", kind: "binary", role: "primary" },
      { id: "cost", kind: "currency", role: "guardrail", unit: "USD", guardrail: { comparison: "gt", threshold: 10 } },
    ],
    createdAt: started,
    createdBy: "creator",
    ...overrides,
  };
}

const unit = (id: string, tenantId = "tenant-a") => ({
  type: "user" as const,
  id,
  tenantId,
  attributes: { country: "US" },
});

test("HMAC bucketing is deterministic, separated by purpose, and tenant-isolated", () => {
  const first = hmacFraction("secret", ["salt", "variant", "tenant-a", "user", "42"]);
  assert.equal(first, hmacFraction("secret", ["salt", "variant", "tenant-a", "user", "42"]));
  assert.notEqual(first, hmacFraction("secret", ["salt", "variant", "tenant-b", "user", "42"]));
  assert.notEqual(first, hmacFraction("secret", ["salt", "allocation", "tenant-a", "user", "42"]));
  assert.ok(first >= 0 && first < 1);
});

test("eligibility, holdouts, allocation, and weighted assignment are deterministic", async () => {
  const store = new InMemoryAssignmentStore();
  const assigner = new ExperimentAssigner(store, "secret");
  const ineligible = await assigner.assign(revision(), { ...unit("x"), attributes: { country: "CA" } }, { now: new Date(started) });
  assert.deepEqual(ineligible, { kind: "ineligible", reason: "predicate" });

  const assignments = await Promise.all(Array.from({ length: 2_000 }, (_, index) =>
    assigner.assign(revision(), unit(String(index)), { now: new Date(started) }),
  ));
  const treatment = assignments.filter((decision) => decision.kind === "assigned" && decision.assignment.variantId === "treatment").length;
  assert.ok(treatment > 1_400 && treatment < 1_600, `unexpected weighted count ${treatment}`);

  const holdout = await assigner.assign(revision({ experimentId: "holdout", holdout: { allocation: 1 } }), unit("held"), { now: new Date(started) });
  assert.equal(holdout.kind, "excluded");
  if (holdout.kind === "excluded") assert.equal(holdout.reason, "holdout");
});

test("atomic assignment pins revisions and epochs under concurrency and reconnect", async () => {
  const store = new InMemoryAssignmentStore();
  const assigner = new ExperimentAssigner(store, "secret");
  const firstRevision = revision();
  const decisions = await Promise.all(Array.from({ length: 20 }, () =>
    assigner.assign(firstRevision, unit("concurrent"), { now: new Date(started), reconnectOf: "session-0" }),
  ));
  const assigned = decisions.map((decision) => {
    assert.equal(decision.kind, "assigned");
    return (decision as Extract<typeof decision, { kind: "assigned" }>).assignment;
  });
  assert.ok(assigned.every((value) => value === assigned[0]));
  assert.equal((await store.listEvents(firstRevision.experimentId)).filter((event) => event.type === "assignment").length, 1);

  const changed = revision({
    revision: 2,
    allocationEpochs: [
      { id: "epoch-1", startsAt: started, allocation: 0.1 },
      { id: "epoch-2", startsAt: "2026-02-01T00:00:00.000Z", allocation: 1, variantWeights: { control: 100, treatment: 0 } },
    ],
  });
  const pinned = await assigner.assign(changed, unit("concurrent"), { now: new Date("2026-03-01T00:00:00.000Z") });
  assert.equal(pinned.kind, "assigned");
  if (pinned.kind === "assigned") {
    assert.equal(pinned.assignment.revision, 1);
    assert.equal(pinned.assignment.epochId, "epoch-1");
    assert.equal(pinned.existing, true);
  }
});

test("layer coordinator selects at most one experiment", async () => {
  const assigner = new ExperimentAssigner(new InMemoryAssignmentStore(), "secret");
  const a = revision({ experimentId: "a", layerId: "voice", layerAllocation: 1 });
  const b = revision({ experimentId: "b", layerId: "voice", layerAllocation: 1 });
  for (let index = 0; index < 100; index++) {
    const result = await assigner.assignLayer([a, b], unit(String(index)), { now: new Date(started) });
    assert.equal(Object.values(result).filter((decision) => decision.kind === "assigned").length, 1);
  }
});

test("ledger events are idempotent and preserve fallback deviations", async () => {
  const store = new InMemoryAssignmentStore();
  const assigner = new ExperimentAssigner(store, "secret");
  const decision = await assigner.assign(revision(), unit("ledger"), { now: new Date(started) });
  assert.equal(decision.kind, "assigned");
  const assignment = (decision as Extract<typeof decision, { kind: "assigned" }>).assignment;
  const first = await assigner.recordExposure({
    assignment,
    idempotencyKey: "exposure:call-1",
    sessionId: "call-1",
    deviation: { reason: "fallback", intendedVariantId: assignment.variantId, actualProvider: "pipecat" },
  });
  const duplicate = await assigner.recordExposure({ assignment, idempotencyKey: "exposure:call-1" });
  assert.equal(duplicate, first);
  assert.equal(first.deviation?.reason, "fallback");

  const outcome = await assigner.recordOutcome({ assignment, metricId: "converted", value: 1, idempotencyKey: "outcome:call-1" });
  const repeated = await assigner.recordOutcome({ assignment, metricId: "converted", value: 0, idempotencyKey: "outcome:call-1" });
  assert.equal(repeated, outcome);
  assert.equal(repeated.value, 1);
});

test("routing adapters produce provider-specific payloads and respect ownership", () => {
  const base: Assignment = {
    experimentId: "routing",
    revision: 1,
    tenantId: "t",
    unitType: "user",
    unitId: "u",
    variantId: "v",
    epochId: "e",
    assignedAt: started,
    routingOwner: "voicekit",
  };
  const cases: ExperimentRevision["variants"][number]["routing"][] = [
    { provider: "elevenagents", branchId: "branch", conversationConfigOverride: { voice: "a" } },
    { provider: "livekit", agentName: "agent", deploymentId: "deployment", metadata: { region: "us" } },
    { provider: "openai", api: "gpt-live", session: { model: "gpt-live" } },
    { provider: "pipecat", agent: "bot", body: { transport: "daily" } },
  ];
  for (const routing of cases) {
    const configured = revision({
      experimentId: "routing",
      eligibility: { op: "always" },
      variants: [
        { id: "v", weight: 1, routing },
        { id: "other", weight: 1, routing },
      ],
    });
    const payload = createRoutingPayload(configured, base);
    assert.equal(payload.provider, routing.provider);
    assert.ok(Object.keys(payload.payload).length > 0);
    assert.equal(resolveRouting(configured, base).owner, "voicekit");
    assert.equal(resolveRouting(configured, { ...base, routingOwner: "native" }).payload, undefined);
  }
});

test("lifecycle enforces RBAC, valid transitions, CAS, and audit history", async () => {
  const store = new InMemoryAssignmentStore();
  const lifecycle = new ExperimentLifecycle(store, new RoleApprovalHook({ create_revision: ["experiment:author"], approve: ["experiment:approve"], start: ["experiment:operate"] }));
  const draft = revision({ status: "draft" });
  await assert.rejects(() => lifecycle.create(draft, { actorId: "nope", roles: [] }), /Not authorized/);
  await lifecycle.create(draft, { actorId: "author", roles: ["experiment:author"] });
  await assert.rejects(() => lifecycle.transition(draft.experimentId, 1, "running", { actorId: "operator", roles: ["experiment:operate"] }), /Invalid transition/);
  await lifecycle.transition(draft.experimentId, 1, "approved", { actorId: "reviewer", roles: ["experiment:approve"], reason: "reviewed" });
  await lifecycle.transition(draft.experimentId, 1, "running", { actorId: "operator", roles: ["experiment:operate"] });
  const audits = await store.listAuditRecords(draft.experimentId);
  assert.deepEqual(audits.map((audit) => audit.action), ["create_revision", "approve", "start"]);
  assert.ok(audits.every(Object.isFrozen));
});

test("ITT summaries include unobserved assignments, metric types, guardrails, and SRM diagnostics", () => {
  const configured = revision();
  const assignmentEvents: LedgerEvent[] = [
    ["u1", "control"], ["u2", "control"], ["u3", "treatment"], ["u4", "treatment"],
  ].map(([id, variantId], index) => ({
    id: `a${index}`, idempotencyKey: `a${index}`, type: "assignment",
    experimentId: configured.experimentId, revision: 1, tenantId: "t", unitType: "user", unitId: id!,
    variantId: variantId!, epochId: "epoch-1", occurredAt: started,
  }));
  const outcomeEvents: LedgerEvent[] = [
    { id: "o1", idempotencyKey: "o1", type: "outcome", experimentId: configured.experimentId, revision: 1, tenantId: "t", unitType: "user", unitId: "u1", metricId: "converted", value: 1, occurredAt: started },
    { id: "o2", idempotencyKey: "o2", type: "outcome", experimentId: configured.experimentId, revision: 1, tenantId: "t", unitType: "user", unitId: "u3", metricId: "cost", value: 25, occurredAt: started },
  ];
  const summary = summarizeIntentionToTreat(configured, [...assignmentEvents, ...outcomeEvents]);
  const conversion = summary.find((item) => item.metric.id === "converted")!;
  assert.equal(conversion.analysis, "intention_to_treat");
  assert.equal(conversion.variants.find((item) => item.variantId === "control")!.meanPerAssignedUnit, 0.5);
  assert.deepEqual(summary.find((item) => item.metric.id === "cost")!.guardrailBreaches, ["treatment"]);

  const diagnostic = diagnoseSampleRatioMismatch(configured, assignmentEvents);
  assert.equal(diagnostic.degreesOfFreedom, 1);
  assert.match(diagnostic.note, /not a statistical significance test/);
});
