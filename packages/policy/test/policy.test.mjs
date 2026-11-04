import assert from "node:assert/strict";
import test from "node:test";
import {
  PolicyEngine,
  consentPolicy,
  maxDurationPolicy,
  retentionPolicy,
  toolAllowlistPolicy,
} from "../dist/index.js";

const context = {
  sessionId: "session",
  now: 1_000,
  startedAt: 0,
  consent: { voice: true },
};

test("standard policies allow and deny", async () => {
  const engine = new PolicyEngine([
    consentPolicy(),
    maxDurationPolicy(2_000),
    toolAllowlistPolicy(["lookup"]),
  ]);
  assert.equal((await engine.admission({}, context)).kind, "allow");
  assert.equal(
    (await engine.tool({ toolName: "delete" }, context)).kind,
    "deny",
  );
});

test("redacts and transforms in sequence", async () => {
  const engine = new PolicyEngine([
    {
      id: "redact",
      stages: ["output"],
      evaluate: () => ({ kind: "redact", paths: ["customer.ssn"] }),
    },
    {
      id: "tag",
      stages: ["output"],
      evaluate: ({ value }) => ({ kind: "transform", value: { ...value, safe: true } }),
    },
  ]);
  const result = await engine.output({ customer: { ssn: "123" } }, context);
  assert.equal(result.kind, "allow");
  assert.deepEqual(result.value, {
    customer: { ssn: "[REDACTED]" },
    safe: true,
  });
});

test("approval resumes at the next policy", async () => {
  let after = 0;
  const engine = new PolicyEngine([
    {
      id: "approval",
      stages: ["tool"],
      evaluate: () => ({ kind: "require-approval", reason: "sensitive" }),
    },
    {
      id: "after",
      stages: ["tool"],
      evaluate: () => {
        after += 1;
        return { kind: "allow" };
      },
    },
  ]);
  const pending = await engine.tool({ toolName: "write" }, context);
  assert.equal(pending.kind, "require-approval");
  const resumed = await engine.resume(pending.approvalToken, true);
  assert.equal(resumed.kind, "allow");
  assert.equal(after, 1);
});

test("fails closed on deadlines and caps retention", async () => {
  const slow = new PolicyEngine([
    {
      id: "slow",
      deadlineMs: 5,
      evaluate: () => new Promise(() => {}),
    },
  ]);
  assert.equal((await slow.turn({}, context)).kind, "deny");

  const retention = new PolicyEngine([retentionPolicy(100)]);
  const result = await retention.retention({ retentionMs: 500 }, context);
  assert.deepEqual(result.value, { retentionMs: 100 });
});
