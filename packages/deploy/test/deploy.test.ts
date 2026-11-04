import assert from "node:assert/strict";
import {
  DeploymentEngine,
  DeploymentExecutionError,
  MemoryReleaseLedger,
  defineDeployment,
  digest,
  planDeployment,
  secret,
  type ExecutionContext,
  type OperationResult,
  type ProviderAdapter,
  type ProviderOperation,
} from "../src/index.js";

const nodeTestSpecifier = ["node", "test"].join(":");
const { test } = await import(nodeTestSpecifier) as typeof import("node:test");

function fixture() {
  return defineDeployment({
    name: "voice-agent",
    resources: [
      { id: "api", provider: "fake", type: "service" },
      { id: "worker", provider: "fake", type: "worker", dependsOn: ["api"] },
    ],
    migrations: [{ id: "schema-v1", provider: "fake", resource: "api" }],
    gates: [{ id: "smoke-test", type: "health", resource: "worker" }],
    environments: {
      preview: { variables: { REGION: "test" }, secrets: { TOKEN: secret("VOICEKIT_TEST_TOKEN") } },
      prod: { variables: { REGION: "primary" }, secrets: { TOKEN: secret("VOICEKIT_PROD_TOKEN") } },
    },
  });
}

class FakeAdapter implements ProviderAdapter {
  readonly provider = "fake";
  readonly applied: string[] = [];
  readonly compensated: string[] = [];
  failOnce = new Set<string>();

  async apply(operation: ProviderOperation, _context: ExecutionContext): Promise<OperationResult> {
    this.applied.push(operation.id);
    if (this.failOnce.delete(operation.id)) throw new Error(`interrupted at ${operation.id}`);
    return { externalId: operation.id, fingerprint: digest(operation.input) };
  }

  async inspect(operation: ProviderOperation): Promise<OperationResult> {
    return { fingerprint: digest(operation.input) };
  }

  async compensate(operation: ProviderOperation): Promise<void> {
    this.compensated.push(operation.id);
  }
}

await test("definition, manifest, and digest are deeply immutable and deterministic", () => {
  const deployment = fixture();
  const first = planDeployment(deployment, "preview");
  const second = planDeployment(deployment, "preview");
  assert.equal(first.digest, second.digest);
  assert.ok(Object.isFrozen(first.manifest));
  assert.ok(Object.isFrozen(first.manifest.operations));
  assert.deepEqual(first.manifest.operations.map(({ id }) => id), ["api", "worker", "schema-v1", "smoke-test"]);
  assert.throws(() => {
    (first.manifest.operations as ProviderOperation[]).push(first.manifest.operations[0]!);
  });
  assert.equal(JSON.stringify(first).includes("VOICEKIT_TEST_TOKEN"), true);
  assert.equal(JSON.stringify(first).includes("secret-value"), false);
});

await test("interrupted release resumes without replaying successful operations", async () => {
  const adapter = new FakeAdapter();
  adapter.failOnce.add("worker");
  const ledger = new MemoryReleaseLedger();
  const engine = new DeploymentEngine({
    adapters: { fake: adapter },
    ledger,
    gates: { async evaluate() { return { passed: true }; } },
  });
  const artifact = planDeployment(fixture(), "preview");

  await assert.rejects(engine.deploy(artifact, "release-1"), DeploymentExecutionError);
  assert.deepEqual(adapter.applied, ["api", "worker"]);

  const release = await engine.deploy(artifact, "release-1");
  assert.equal(release.state, "succeeded");
  assert.deepEqual(adapter.applied, ["api", "worker", "worker", "schema-v1"]);
  assert.equal(release.operations.api?.attempts, 1);
  assert.equal(release.operations.worker?.attempts, 2);
});

await test("rollback compensates successful reversible operations in reverse order and resumes", async () => {
  const adapter = new FakeAdapter();
  const ledger = new MemoryReleaseLedger();
  const engine = new DeploymentEngine({
    adapters: { fake: adapter },
    ledger,
    gates: { async evaluate() { return { passed: true }; } },
  });
  const artifact = planDeployment(fixture(), "prod");
  await engine.deploy(artifact, "release-2");
  const rolledBack = await engine.rollback(artifact, "release-2");
  assert.equal(rolledBack.state, "rolled-back");
  assert.deepEqual(adapter.compensated, ["worker", "api"]);
  assert.equal(rolledBack.operations.api?.state, "compensated");
});

await test("schema rejects secret values and dependency cycles", () => {
  assert.throws(
    () =>
      defineDeployment({
        name: "bad-agent",
        resources: [
          { id: "one", provider: "fake", type: "service", dependsOn: ["two"] },
          { id: "two", provider: "fake", type: "service", dependsOn: ["one"] },
        ],
        environments: {
          preview: { secrets: { TOKEN: { name: "TOKEN", value: "do-not-store" } } as never },
          prod: {},
        },
      }),
    /Invalid deployment/,
  );
});
