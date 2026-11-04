import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ToolApprovalError,
  ToolDeniedError,
  ToolExecutor,
  defineTool,
} from "../dist/index.js";

const lookup = defineTool({
  name: "lookup",
  description: "Look up a customer",
  input: z.object({ id: z.string() }),
  output: z.object({ name: z.string() }),
  execution: "server",
  effect: "read",
  scopes: ["customers:read"],
  idempotent: true,
  execute: async ({ id }) => ({ name: id }),
});

test("validates input, scopes, and output", async () => {
  const executor = new ToolExecutor();
  await assert.rejects(
    executor.execute(lookup, { id: "1" }, { callId: "c", sessionId: "s" }),
    ToolDeniedError,
  );
  assert.deepEqual(
    await executor.execute(lookup, { id: "1" }, {
      callId: "c",
      sessionId: "s",
      scopes: ["customers:read"],
    }),
    { name: "1" },
  );
});

test("deduplicates concurrent idempotent calls", async () => {
  let calls = 0;
  const tool = defineTool({
    name: "once",
    description: "Run once",
    input: z.object({}),
    output: z.number(),
    execution: "server",
    effect: "write",
    idempotent: true,
    execute: async () => ++calls,
  });
  const executor = new ToolExecutor();
  const options = { callId: "c", sessionId: "s", idempotencyKey: "same" };
  assert.deepEqual(await Promise.all([
    executor.execute(tool, {}, options),
    executor.execute(tool, {}, options),
  ]), [1, 1]);
  assert.equal(calls, 1);
});

test("requires explicit approval from policy", async () => {
  const executor = new ToolExecutor({
    policy: async () => ({ kind: "require-approval", reason: "write" }),
    approve: async () => false,
  });
  const tool = defineTool({
    name: "write",
    description: "Write data",
    input: z.object({}),
    output: z.boolean(),
    execution: "server",
    effect: "write",
    execute: async () => true,
  });
  await assert.rejects(
    executor.execute(tool, {}, { callId: "c", sessionId: "s" }),
    ToolApprovalError,
  );
});
