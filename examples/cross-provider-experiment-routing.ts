import {
  ExperimentAssigner,
  InMemoryAssignmentStore,
  createRoutingPayload,
  type ExperimentRevision,
} from "@jchaffin/voicekit-experiments";

const revision: ExperimentRevision = {
  experimentId: "voice-provider-2026",
  revision: 1,
  status: "running",
  salt: "store-this-immutable-salt-server-side",
  assignmentUnitType: "user",
  eligibility: { op: "always" },
  variants: [
    { id: "live", weight: 1, routing: { provider: "openai", api: "gpt-live", session: {} } },
    { id: "hosted", weight: 1, routing: { provider: "livekit", agentName: "support", deploymentId: "support-alpha-1" } },
  ],
  allocationEpochs: [{ id: "launch", startsAt: "2026-01-01T00:00:00.000Z", allocation: 1 }],
  metrics: [{ id: "resolved", kind: "binary", role: "primary", direction: "increase" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "release@example.com",
};

const store = new InMemoryAssignmentStore();
const assigner = new ExperimentAssigner(store, "server-only-hmac-key");

export async function routeUser(userId: string) {
  const decision = await assigner.assign(revision, { type: "user", id: userId, tenantId: "acme" });
  if (decision.kind !== "assigned") return decision;
  return createRoutingPayload(revision, decision.assignment);
}
