import assert from "node:assert/strict";
import test from "node:test";
import {
  HandoffCoordinator,
  defineAgent,
  defineAgentGraph,
  replace,
} from "../dist/index.js";

test("defineAgentGraph validates graph integrity", () => {
  const a = defineAgent({ id: "a" });
  const b = defineAgent({ id: "b" });
  const edge = replace({ id: "a-b", from: "a", to: "b", projectContext: () => ({}) });
  const graph = defineAgentGraph({ entry: "a", agents: [a, b], handoffs: [edge] });
  assert.equal(graph.agentById.get("b"), b);
  assert.throws(
    () => defineAgentGraph({ entry: "a", agents: [a, a] }),
    /Duplicate agent/,
  );
});

test("handoff commits in atomic order", async () => {
  const calls = [];
  const edge = replace({
    id: "sales",
    from: "router",
    to: "sales",
    projectContext: ({ name }) => ({ customer: name }),
  });
  const result = await new HandoffCoordinator().execute(edge, { name: "Ada" }, {
    freeze: async () => calls.push("freeze"),
    drain: async () => calls.push("drain"),
    initializeTarget: async () => calls.push("init"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    unfreeze: async () => calls.push("unfreeze"),
  });
  assert.deepEqual(calls, ["freeze", "drain", "init", "commit"]);
  assert.deepEqual(result.context, { customer: "Ada" });
});

test("handoff rolls back and unfreezes on failure", async () => {
  const calls = [];
  const edge = replace({
    id: "broken",
    from: "a",
    to: "b",
    projectContext: () => ({}),
  });
  await assert.rejects(
    new HandoffCoordinator().execute(edge, {}, {
      freeze: async () => calls.push("freeze"),
      drain: async () => calls.push("drain"),
      initializeTarget: async () => { throw new Error("offline"); },
      commit: async () => calls.push("commit"),
      rollback: async () => calls.push("rollback"),
      unfreeze: async () => calls.push("unfreeze"),
    }),
    /offline/,
  );
  assert.deepEqual(calls, ["freeze", "drain", "rollback", "unfreeze"]);
});
