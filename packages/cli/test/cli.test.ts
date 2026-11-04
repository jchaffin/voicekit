import assert from "node:assert/strict";
import {
  DeploymentEngine,
  MemoryReleaseLedger,
  defineDeployment,
  type ProviderAdapter,
} from "@jchaffin/voicekit-deploy";
import { ExitCode, parseArgs, runCli } from "../src/index.js";

const nodeTestSpecifier = ["node", "test"].join(":");
const { test } = await import(nodeTestSpecifier) as typeof import("node:test");

const definition = defineDeployment({
  name: "cli-agent",
  resources: [{ id: "service", provider: "fake", type: "service" }],
  environments: { preview: {}, prod: {} },
});

function harness() {
  const output: string[] = [];
  const errors: string[] = [];
  const ledger = new MemoryReleaseLedger();
  const adapter: ProviderAdapter = {
    provider: "fake",
    async apply() { return { externalId: "external-1", fingerprint: "same" }; },
    async inspect() { return { fingerprint: "same" }; },
    async compensate() {},
    async logs() { return ["one", "two"]; },
    async test() { return { output: { ok: true } }; },
  };
  return {
    output,
    errors,
    dependencies: {
      cwd: "/tmp/project",
      ledger,
      io: {
        stdout(value: string) { output.push(value); },
        stderr(value: string) { errors.push(value); },
      },
      async loadConfig() { return definition; },
      createEngine() {
        return new DeploymentEngine({ adapters: { fake: adapter }, ledger, id: () => "release-test" });
      },
    },
  };
}

await test("argument parser is strict and resolves paths", () => {
  const options = parseArgs(["deploy", "--env=prod", "--json"], "/workspace");
  assert.equal(options.environment, "prod");
  assert.equal(options.config, "/workspace/voicekit.config.js");
  assert.equal(options.json, true);
  assert.throws(() => parseArgs(["status"], "/workspace"), /--release is required/);
  assert.throws(() => parseArgs(["plan", "--wat"], "/workspace"), /Unknown option/);
});

await test("plan and deploy support human and JSON output", async () => {
  const plan = harness();
  assert.equal(await runCli(["plan", "--json"], plan.dependencies), ExitCode.Success);
  assert.equal(JSON.parse(plan.output[0]!).manifest.deployment, "cli-agent");

  const deploy = harness();
  assert.equal(await runCli(["deploy", "--release", "release-test"], deploy.dependencies), ExitCode.Success);
  assert.match(deploy.output[0]!, /State: succeeded/);
});

await test("status, logs, test, and rollback return useful results", async () => {
  const value = harness();
  await runCli(["deploy", "--release", "release-test"], value.dependencies);
  value.output.length = 0;

  assert.equal(
    await runCli(["status", "--release", "release-test", "--json"], value.dependencies),
    ExitCode.Success,
  );
  assert.equal(JSON.parse(value.output.pop()!).state, "succeeded");

  assert.equal(
    await runCli(
      ["logs", "--release", "release-test", "--provider", "fake", "--resource", "service"],
      value.dependencies,
    ),
    ExitCode.Success,
  );
  assert.equal(value.output.pop(), "one\ntwo");

  assert.equal(
    await runCli(
      ["test", "--release", "release-test", "--provider", "fake", "--resource", "service"],
      value.dependencies,
    ),
    ExitCode.Success,
  );
  assert.match(value.output.pop()!, /Test passed/);

  assert.equal(
    await runCli(["rollback", "--release", "release-test"], value.dependencies),
    ExitCode.Success,
  );
  assert.match(value.output.pop()!, /State: rolled-back/);
});

await test("missing releases and usage failures have distinct exit codes", async () => {
  const value = harness();
  assert.equal(await runCli(["status", "--release", "missing"], value.dependencies), ExitCode.NotFound);
  assert.equal(await runCli(["logs"], value.dependencies), ExitCode.Usage);
});
