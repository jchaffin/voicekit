import { createHash, randomUUID } from "node:crypto";

export const DEPLOYMENT_SCHEMA_VERSION = "voicekit.deployment/v1" as const;
export type EnvironmentName = "preview" | "prod";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ProviderKind = "vercel" | "livekit" | "elevenlabs" | "managed" | "pipecat";
export type OperationAction =
  | "configure"
  | "deploy"
  | "migrate"
  | "verify"
  | "promote"
  | "delete";

export interface SecretReference {
  readonly name: string;
}

export interface EnvironmentConfig {
  readonly variables?: Readonly<Record<string, JsonPrimitive>>;
  readonly secrets?: Readonly<Record<string, SecretReference>>;
  readonly providers?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
}

export interface ResourceConfig {
  readonly id: string;
  readonly provider: ProviderKind | (string & {});
  readonly type: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly dependsOn?: readonly string[];
  readonly reversible?: boolean;
}

export interface GateConfig {
  readonly id: string;
  readonly type: "approval" | "health" | "test";
  readonly resource?: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
}

export interface MigrationConfig {
  readonly id: string;
  readonly provider: ProviderKind | (string & {});
  readonly resource: string;
  readonly command?: readonly string[];
  readonly config?: Readonly<Record<string, JsonValue>>;
  readonly dependsOn?: readonly string[];
  readonly reversible?: boolean;
}

export interface DeploymentInput {
  readonly name: string;
  readonly resources: readonly ResourceConfig[];
  readonly environments: Readonly<{
    preview: EnvironmentConfig;
    prod: EnvironmentConfig;
  }>;
  readonly gates?: readonly GateConfig[];
  readonly migrations?: readonly MigrationConfig[];
}

export interface DeploymentDefinition extends DeploymentInput {
  readonly schemaVersion: typeof DEPLOYMENT_SCHEMA_VERSION;
}

export interface ProviderOperation {
  readonly id: string;
  readonly provider: string;
  readonly action: OperationAction;
  readonly resource: string;
  readonly resourceType: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly dependsOn: readonly string[];
  readonly reversible: boolean;
  readonly phase: "provision" | "migration" | "gate" | "promotion";
}

export interface DeploymentManifest {
  readonly schemaVersion: typeof DEPLOYMENT_SCHEMA_VERSION;
  readonly deployment: string;
  readonly environment: EnvironmentName;
  readonly operations: readonly ProviderOperation[];
}

export interface ManifestArtifact {
  readonly manifest: DeploymentManifest;
  readonly digest: string;
}

export interface DriftRecord {
  readonly operationId: string;
  readonly expected: string;
  readonly actual?: string;
  readonly state: "in-sync" | "missing" | "changed" | "unknown";
  readonly detail?: string;
}

export interface OperationResult {
  readonly externalId?: string;
  readonly output?: Readonly<Record<string, JsonValue>>;
  readonly fingerprint?: string;
}

export interface ProviderAdapter {
  readonly provider: string;
  apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult>;
  inspect?(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult | undefined>;
  compensate?(operation: ProviderOperation, result: OperationResult, context: ExecutionContext): Promise<void>;
  logs?(resource: string, context: ExecutionContext): Promise<readonly string[]>;
  test?(resource: string, context: ExecutionContext): Promise<OperationResult>;
}

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
}

export interface HttpResponse {
  readonly status: number;
  readonly body?: JsonValue;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface ExecutionContext {
  readonly releaseId: string;
  readonly deployment: string;
  readonly environment: EnvironmentName;
  readonly manifestDigest: string;
  readonly secrets: SecretResolver;
}

export interface SecretResolver {
  resolve(name: string): Promise<string>;
}

export type OperationState = "pending" | "running" | "succeeded" | "failed" | "compensated";
export interface OperationLedgerEntry {
  readonly operationId: string;
  readonly state: OperationState;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: OperationResult;
  readonly error?: string;
}

export type ReleaseState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolling-back"
  | "rolled-back";

export interface ReleaseRecord {
  readonly id: string;
  readonly deployment: string;
  readonly environment: EnvironmentName;
  readonly manifestDigest: string;
  readonly state: ReleaseState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly operations: Readonly<Record<string, OperationLedgerEntry>>;
  readonly error?: string;
}

export interface SagaLedger {
  getOperation(releaseId: string, operationId: string): Promise<OperationLedgerEntry | undefined>;
  putOperation(releaseId: string, entry: OperationLedgerEntry): Promise<void>;
}

export interface ReleaseLedger extends SagaLedger {
  create(record: ReleaseRecord): Promise<void>;
  get(releaseId: string): Promise<ReleaseRecord | undefined>;
  update(record: ReleaseRecord): Promise<void>;
  list?(deployment?: string, environment?: EnvironmentName): Promise<readonly ReleaseRecord[]>;
}

export interface GateEvaluator {
  evaluate(gate: GateConfig, context: ExecutionContext): Promise<{ passed: boolean; detail?: string }>;
}

export interface DeploymentEngineOptions {
  readonly adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly ledger: ReleaseLedger;
  readonly secrets?: SecretResolver;
  readonly gates?: GateEvaluator;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export class DeploymentValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid deployment:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "DeploymentValidationError";
    this.issues = issues;
  }
}

export class DeploymentExecutionError extends Error {
  readonly release: ReleaseRecord;
  constructor(message: string, release: ReleaseRecord) {
    super(message);
    this.name = "DeploymentExecutionError";
    this.release = release;
  }
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{1,62}$/;

export function validateSecretName(name: string): string {
  if (!SECRET_NAME.test(name)) {
    throw new DeploymentValidationError([
      `secret name "${name}" must use 2-128 uppercase letters, digits, or underscores and start with a letter`,
    ]);
  }
  return name;
}

export function secret(name: string): SecretReference {
  return deepFreeze({ name: validateSecretName(name) });
}

export function defineDeployment(input: DeploymentInput): DeploymentDefinition {
  const issues: string[] = [];
  if (!RESOURCE_ID.test(input.name)) issues.push("name must be a lowercase kebab-case identifier");
  if (!Array.isArray(input.resources) || input.resources.length === 0) {
    issues.push("resources must contain at least one resource");
  }
  const ids = new Set<string>();
  for (const resource of input.resources ?? []) {
    if (!RESOURCE_ID.test(resource.id)) issues.push(`resource "${resource.id}" has an invalid id`);
    if (ids.has(resource.id)) issues.push(`resource id "${resource.id}" is duplicated`);
    ids.add(resource.id);
    if (!resource.provider) issues.push(`resource "${resource.id}" requires a provider`);
    if (!resource.type) issues.push(`resource "${resource.id}" requires a type`);
  }
  for (const resource of input.resources ?? []) {
    for (const dependency of resource.dependsOn ?? []) {
      if (!ids.has(dependency)) issues.push(`resource "${resource.id}" depends on unknown resource "${dependency}"`);
      if (dependency === resource.id) issues.push(`resource "${resource.id}" cannot depend on itself`);
    }
  }
  if (!input.environments?.preview) issues.push("environments.preview is required");
  if (!input.environments?.prod) issues.push("environments.prod is required");
  for (const [environment, config] of Object.entries(input.environments ?? {})) {
    for (const [key, reference] of Object.entries(config.secrets ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        issues.push(`${environment} secret binding "${key}" must be an uppercase environment variable name`);
      }
      try {
        validateSecretName(reference.name);
      } catch {
        issues.push(`${environment} secret binding "${key}" has invalid secret name "${reference.name}"`);
      }
      if (Object.keys(reference).some((field) => field !== "name")) {
        issues.push(`${environment} secret binding "${key}" may contain only a secret name, never a value`);
      }
    }
  }
  const operationIds = new Set(ids);
  for (const migration of input.migrations ?? []) {
    if (!RESOURCE_ID.test(migration.id)) issues.push(`migration "${migration.id}" has an invalid id`);
    if (operationIds.has(migration.id)) issues.push(`migration id "${migration.id}" is duplicated`);
    operationIds.add(migration.id);
    if (!ids.has(migration.resource)) issues.push(`migration "${migration.id}" targets unknown resource "${migration.resource}"`);
  }
  for (const gate of input.gates ?? []) {
    if (!RESOURCE_ID.test(gate.id)) issues.push(`gate "${gate.id}" has an invalid id`);
    if (operationIds.has(gate.id)) issues.push(`gate id "${gate.id}" is duplicated`);
    operationIds.add(gate.id);
    if (gate.resource && !ids.has(gate.resource)) issues.push(`gate "${gate.id}" targets unknown resource "${gate.resource}"`);
  }
  if (issues.length) throw new DeploymentValidationError(issues);

  const definition = {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    ...input,
  } satisfies DeploymentDefinition;
  // Planning also detects indirect dependency cycles before accepting the schema.
  topologicalSort(
    definition.resources.map((resource) => ({
      id: resource.id,
      dependsOn: [...(resource.dependsOn ?? [])],
    })),
  );
  return deepFreeze(definition);
}

export function planDeployment(
  definition: DeploymentDefinition,
  environment: EnvironmentName,
): ManifestArtifact {
  const environmentConfig = definition.environments[environment];
  const resourceOperations: ProviderOperation[] = definition.resources.map((resource) => {
    const providerConfig = environmentConfig.providers?.[resource.provider] ?? {};
    return {
      id: resource.id,
      provider: resource.provider,
      action: "deploy",
      resource: resource.id,
      resourceType: resource.type,
      input: deepFreeze({
        ...(resource.config ?? {}),
        environment: environment as JsonValue,
        variables: (environmentConfig.variables ?? {}) as Record<string, JsonValue>,
        secretNames: Object.fromEntries(
          Object.entries(environmentConfig.secrets ?? {}).map(([key, value]) => [key, value.name]),
        ),
        provider: providerConfig as JsonValue,
      }),
      dependsOn: [...(resource.dependsOn ?? [])],
      reversible: resource.reversible !== false,
      phase: "provision",
    };
  });
  const migrationOperations: ProviderOperation[] = (definition.migrations ?? []).map((migration) => ({
    id: migration.id,
    provider: migration.provider,
    action: "migrate",
    resource: migration.resource,
    resourceType: "migration",
    input: deepFreeze({
      ...(migration.config ?? {}),
      command: [...(migration.command ?? [])],
    }),
    dependsOn: [...new Set([migration.resource, ...(migration.dependsOn ?? [])])],
    reversible: migration.reversible === true,
    phase: "migration",
  }));
  const migrationIds = migrationOperations.map(({ id }) => id);
  const gateOperations: ProviderOperation[] = (definition.gates ?? []).map((gate) => ({
    id: gate.id,
    provider: "gate",
    action: "verify",
    resource: gate.resource ?? definition.name,
    resourceType: gate.type,
    input: deepFreeze({ ...(gate.config ?? {}), gateId: gate.id, gateType: gate.type }),
    dependsOn: gate.resource ? [gate.resource, ...migrationIds] : [...resourceOperations.map(({ id }) => id), ...migrationIds],
    reversible: false,
    phase: "gate",
  }));
  const operations = topologicalSort(
    [...resourceOperations, ...migrationOperations, ...gateOperations].map((operation) => ({
      id: operation.id,
      dependsOn: operation.dependsOn,
      value: operation,
    })),
  ).map((node) => node.value as ProviderOperation);
  const manifest = deepFreeze({
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    deployment: definition.name,
    environment,
    operations,
  } satisfies DeploymentManifest);
  return deepFreeze({ manifest, digest: digest(manifest) });
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function topologicalSort<T extends { id: string; dependsOn: readonly string[] }>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: T[] = [];
  const visit = (node: T): void => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) throw new DeploymentValidationError([`dependency cycle includes "${node.id}"`]);
    visiting.add(node.id);
    for (const id of node.dependsOn) {
      const dependency = byId.get(id);
      if (dependency) visit(dependency);
    }
    visiting.delete(node.id);
    visited.add(node.id);
    result.push(node);
  };
  nodes.forEach(visit);
  return result;
}

const noSecrets: SecretResolver = {
  async resolve(name: string): Promise<string> {
    throw new Error(`No secret resolver configured for "${name}"`);
  },
};

export class DeploymentEngine {
  readonly #adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly #ledger: ReleaseLedger;
  readonly #secrets: SecretResolver;
  readonly #gates: GateEvaluator | undefined;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: DeploymentEngineOptions) {
    this.#adapters = options.adapters;
    this.#ledger = options.ledger;
    this.#secrets = options.secrets ?? noSecrets;
    this.#gates = options.gates;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  async deploy(artifact: ManifestArtifact, releaseId = this.#id()): Promise<ReleaseRecord> {
    let release = await this.#ledger.get(releaseId);
    if (release && release.manifestDigest !== artifact.digest) {
      throw new Error(`Release "${releaseId}" belongs to a different manifest`);
    }
    if (!release) {
      const timestamp = this.#now().toISOString();
      release = {
        id: releaseId,
        deployment: artifact.manifest.deployment,
        environment: artifact.manifest.environment,
        manifestDigest: artifact.digest,
        state: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        operations: {},
      };
      await this.#ledger.create(release);
    }
    if (release.state === "succeeded" || release.state === "rolled-back") return release;
    release = await this.#save({ ...withoutError(release), state: "running" });
    const context = this.#context(release);
    try {
      for (const operation of artifact.manifest.operations) {
        const previous = release.operations[operation.id];
        if (previous?.state === "succeeded") continue;
        for (const dependency of operation.dependsOn) {
          if (release.operations[dependency]?.state !== "succeeded") {
            throw new Error(`Operation "${operation.id}" has incomplete dependency "${dependency}"`);
          }
        }
        release = await this.#operation(release, operation, context);
      }
      return await this.#save({ ...withoutError(release), state: "succeeded" });
    } catch (error) {
      const message = errorMessage(error);
      release = (await this.#ledger.get(releaseId)) ?? release;
      release = await this.#save({ ...release, state: "failed", error: message });
      throw new DeploymentExecutionError(message, release);
    }
  }

  async rollback(artifact: ManifestArtifact, releaseId: string): Promise<ReleaseRecord> {
    let release = await this.#requiredRelease(releaseId, artifact.digest);
    release = await this.#save({ ...withoutError(release), state: "rolling-back" });
    const context = this.#context(release);
    try {
      for (const operation of [...artifact.manifest.operations].reverse()) {
        const entry = release.operations[operation.id];
        if (entry?.state !== "succeeded" || !operation.reversible) continue;
        const adapter = this.#adapters[operation.provider];
        if (!adapter?.compensate) throw new Error(`Provider "${operation.provider}" cannot compensate "${operation.id}"`);
        await adapter.compensate(operation, entry.result ?? {}, context);
        release = await this.#save({
          ...release,
          operations: {
            ...release.operations,
            [operation.id]: { ...entry, state: "compensated", finishedAt: this.#now().toISOString() },
          },
        });
      }
      return await this.#save({ ...release, state: "rolled-back" });
    } catch (error) {
      const message = errorMessage(error);
      release = await this.#save({ ...release, state: "failed", error: message });
      throw new DeploymentExecutionError(message, release);
    }
  }

  async drift(artifact: ManifestArtifact, releaseId: string): Promise<readonly DriftRecord[]> {
    const release = await this.#requiredRelease(releaseId, artifact.digest);
    const context = this.#context(release);
    const records: DriftRecord[] = [];
    for (const operation of artifact.manifest.operations) {
      if (operation.provider === "gate") continue;
      const expected = release.operations[operation.id]?.result?.fingerprint ?? digest(operation.input);
      const adapter = this.#adapters[operation.provider];
      if (!adapter?.inspect) {
        records.push({ operationId: operation.id, expected, state: "unknown", detail: "provider does not support inspection" });
        continue;
      }
      const current = await adapter.inspect(operation, context);
      const actual = current?.fingerprint;
      records.push({
        operationId: operation.id,
        expected,
        ...(actual ? { actual } : {}),
        state: !current ? "missing" : actual === expected ? "in-sync" : "changed",
      });
    }
    return deepFreeze(records);
  }

  async status(releaseId: string): Promise<ReleaseRecord | undefined> {
    return this.#ledger.get(releaseId);
  }

  async logs(provider: string, resource: string, releaseId: string): Promise<readonly string[]> {
    const release = await this.#requiredRelease(releaseId);
    const adapter = this.#adapters[provider];
    if (!adapter?.logs) throw new Error(`Provider "${provider}" does not support logs`);
    return adapter.logs(resource, this.#context(release));
  }

  async test(provider: string, resource: string, releaseId: string): Promise<OperationResult> {
    const release = await this.#requiredRelease(releaseId);
    const adapter = this.#adapters[provider];
    if (!adapter?.test) throw new Error(`Provider "${provider}" does not support tests`);
    return adapter.test(resource, this.#context(release));
  }

  async #operation(
    release: ReleaseRecord,
    operation: ProviderOperation,
    context: ExecutionContext,
  ): Promise<ReleaseRecord> {
    const previous = release.operations[operation.id];
    const attempts = (previous?.attempts ?? 0) + 1;
    const running: OperationLedgerEntry = {
      operationId: operation.id,
      state: "running",
      attempts,
      startedAt: this.#now().toISOString(),
    };
    release = await this.#save({ ...release, operations: { ...release.operations, [operation.id]: running } });
    try {
      let result: OperationResult;
      if (operation.provider === "gate") {
        if (!this.#gates) throw new Error(`No gate evaluator configured for "${operation.id}"`);
        const gate: GateConfig = {
          id: String(operation.input.gateId),
          type: String(operation.input.gateType) as GateConfig["type"],
          ...(operation.resource !== release.deployment ? { resource: operation.resource } : {}),
          config: operation.input,
        };
        const evaluation = await this.#gates.evaluate(gate, context);
        if (!evaluation.passed) throw new Error(evaluation.detail ?? `Gate "${operation.id}" failed`);
        result = { output: { passed: true, detail: evaluation.detail ?? null }, fingerprint: digest(evaluation) };
      } else {
        const adapter = this.#adapters[operation.provider];
        if (!adapter) throw new Error(`No adapter registered for provider "${operation.provider}"`);
        result = await adapter.apply(operation, context);
      }
      const succeeded: OperationLedgerEntry = {
        ...running,
        state: "succeeded",
        result: deepFreeze({ ...result, fingerprint: result.fingerprint ?? digest(result.output ?? operation.input) }),
        finishedAt: this.#now().toISOString(),
      };
      return this.#save({ ...release, operations: { ...release.operations, [operation.id]: succeeded } });
    } catch (error) {
      const failed: OperationLedgerEntry = {
        ...running,
        state: "failed",
        error: errorMessage(error),
        finishedAt: this.#now().toISOString(),
      };
      await this.#save({ ...release, operations: { ...release.operations, [operation.id]: failed } });
      throw error;
    }
  }

  #context(release: ReleaseRecord): ExecutionContext {
    return {
      releaseId: release.id,
      deployment: release.deployment,
      environment: release.environment,
      manifestDigest: release.manifestDigest,
      secrets: this.#secrets,
    };
  }

  async #requiredRelease(id: string, digestValue?: string): Promise<ReleaseRecord> {
    const release = await this.#ledger.get(id);
    if (!release) throw new Error(`Release "${id}" was not found`);
    if (digestValue && release.manifestDigest !== digestValue) throw new Error(`Release "${id}" belongs to a different manifest`);
    return release;
  }

  async #save(record: Omit<ReleaseRecord, "updatedAt"> & { updatedAt?: string }): Promise<ReleaseRecord> {
    const saved = deepFreeze({ ...record, updatedAt: this.#now().toISOString() }) as ReleaseRecord;
    await this.#ledger.update(saved);
    return saved;
  }
}

export class MemoryReleaseLedger implements ReleaseLedger {
  readonly #records = new Map<string, ReleaseRecord>();
  async create(record: ReleaseRecord): Promise<void> {
    if (this.#records.has(record.id)) throw new Error(`Release "${record.id}" already exists`);
    this.#records.set(record.id, structuredClone(record));
  }
  async get(releaseId: string): Promise<ReleaseRecord | undefined> {
    const record = this.#records.get(releaseId);
    return record ? deepFreeze(structuredClone(record)) : undefined;
  }
  async update(record: ReleaseRecord): Promise<void> {
    if (!this.#records.has(record.id)) throw new Error(`Release "${record.id}" was not found`);
    this.#records.set(record.id, structuredClone(record));
  }
  async getOperation(releaseId: string, operationId: string): Promise<OperationLedgerEntry | undefined> {
    const entry = this.#records.get(releaseId)?.operations[operationId];
    return entry ? deepFreeze(structuredClone(entry)) : undefined;
  }
  async putOperation(releaseId: string, entry: OperationLedgerEntry): Promise<void> {
    const release = this.#records.get(releaseId);
    if (!release) throw new Error(`Release "${releaseId}" was not found`);
    this.#records.set(releaseId, structuredClone({
      ...release,
      operations: { ...release.operations, [entry.operationId]: entry },
    }));
  }
  async list(deployment?: string, environment?: EnvironmentName): Promise<readonly ReleaseRecord[]> {
    return [...this.#records.values()]
      .filter((record) => (!deployment || record.deployment === deployment) && (!environment || record.environment === environment))
      .map((record) => deepFreeze(structuredClone(record)));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutError(record: ReleaseRecord): Omit<ReleaseRecord, "error"> {
  const { error: _error, ...rest } = record;
  return rest;
}

function assertCommand(result: CommandResult, label: string): OperationResult {
  if (result.exitCode !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.stderr.trim()}`);
  const output = result.stdout.trim();
  return { output: { stdout: output }, fingerprint: digest(output) };
}

abstract class CommandAdapter implements ProviderAdapter {
  abstract readonly provider: string;
  readonly runner: CommandRunner;
  constructor(runner: CommandRunner) {
    this.runner = runner;
  }
  abstract apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult>;
  async compensate(operation: ProviderOperation, _result: OperationResult, context: ExecutionContext): Promise<void> {
    const result = await this.runner.run({
      command: this.provider,
      args: ["rollback", operation.resource, "--release", context.releaseId],
    });
    assertCommand(result, `${this.provider} rollback`);
  }
  async logs(resource: string): Promise<readonly string[]> {
    const result = await this.runner.run({ command: this.provider, args: ["logs", resource] });
    assertCommand(result, `${this.provider} logs`);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }
  async test(resource: string): Promise<OperationResult> {
    return assertCommand(
      await this.runner.run({ command: this.provider, args: ["test", resource] }),
      `${this.provider} test`,
    );
  }
}

export class VercelAdapter extends CommandAdapter {
  readonly provider = "vercel";
  async apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult> {
    const args =
      operation.action === "migrate"
        ? ["env", "run", "--", ...jsonStringArray(operation.input.command)]
        : ["deploy", "--yes", "--meta", `voicekitRelease=${context.releaseId}`, "--name", operation.resource];
    if (context.environment === "prod") args.push("--prod");
    return assertCommand(await this.runner.run({ command: "vercel", args }), "Vercel operation");
  }
  override async compensate(operation: ProviderOperation): Promise<void> {
    assertCommand(
      await this.runner.run({ command: "vercel", args: ["remove", operation.resource, "--yes"] }),
      "Vercel rollback",
    );
  }
}

export class LiveKitCloudAdapter extends CommandAdapter {
  readonly provider = "livekit";
  async apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult> {
    const args =
      operation.action === "migrate"
        ? ["cloud", "run", operation.resource, "--", ...jsonStringArray(operation.input.command)]
        : ["cloud", "deploy", operation.resource, "--tag", context.manifestDigest.slice(0, 12)];
    return assertCommand(await this.runner.run({ command: "lk", args }), "LiveKit Cloud operation");
  }
  override async compensate(operation: ProviderOperation): Promise<void> {
    assertCommand(
      await this.runner.run({ command: "lk", args: ["cloud", "delete", operation.resource, "--yes"] }),
      "LiveKit Cloud rollback",
    );
  }
}

abstract class JsonHttpAdapter implements ProviderAdapter {
  abstract readonly provider: string;
  readonly client: HttpClient;
  readonly baseUrl: string;
  constructor(client: HttpClient, baseUrl: string) {
    this.client = client;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  async apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult> {
    const response = await this.client.request({
      method: "PUT",
      url: `${this.baseUrl}/resources/${encodeURIComponent(operation.resource)}`,
      headers: { "idempotency-key": `${context.releaseId}:${operation.id}` },
      body: operation.input,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${this.provider} request failed with status ${response.status}`);
    }
    return { output: asRecord(response.body), fingerprint: digest(response.body ?? operation.input) };
  }
  async inspect(operation: ProviderOperation): Promise<OperationResult | undefined> {
    const response = await this.client.request({
      method: "GET",
      url: `${this.baseUrl}/resources/${encodeURIComponent(operation.resource)}`,
    });
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) throw new Error(`${this.provider} inspect failed with status ${response.status}`);
    return { output: asRecord(response.body), fingerprint: digest(response.body) };
  }
  async compensate(operation: ProviderOperation): Promise<void> {
    const response = await this.client.request({
      method: "DELETE",
      url: `${this.baseUrl}/resources/${encodeURIComponent(operation.resource)}`,
    });
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) {
      throw new Error(`${this.provider} rollback failed with status ${response.status}`);
    }
  }
  async test(resource: string): Promise<OperationResult> {
    const response = await this.client.request({ method: "POST", url: `${this.baseUrl}/resources/${encodeURIComponent(resource)}/test` });
    if (response.status < 200 || response.status >= 300) throw new Error(`${this.provider} test failed with status ${response.status}`);
    return { output: asRecord(response.body), fingerprint: digest(response.body) };
  }
  async logs(resource: string): Promise<readonly string[]> {
    const response = await this.client.request({ method: "GET", url: `${this.baseUrl}/resources/${encodeURIComponent(resource)}/logs` });
    if (response.status < 200 || response.status >= 300) throw new Error(`${this.provider} logs failed with status ${response.status}`);
    if (!Array.isArray(response.body)) return [];
    return response.body.map(String);
  }
}

export class ElevenLabsAdapter extends JsonHttpAdapter {
  readonly provider = "elevenlabs";
  constructor(client: HttpClient, baseUrl = "https://api.elevenlabs.io/v1") {
    super(client, baseUrl);
  }
}

export class ManagedProviderAdapter extends JsonHttpAdapter {
  readonly provider: string;
  constructor(provider: string, client: HttpClient, baseUrl: string) {
    super(client, baseUrl);
    this.provider = provider;
  }
}

export class PipecatServiceAdapter extends CommandAdapter {
  readonly provider = "pipecat";
  async apply(operation: ProviderOperation, context: ExecutionContext): Promise<OperationResult> {
    const source = generatePipecatService(operation, context);
    return assertCommand(
      await this.runner.run({
        command: "voicekit-pipecat",
        args: ["deploy", operation.resource, "--release", context.releaseId],
        stdin: source,
      }),
      "Pipecat deployment",
    );
  }
}

export function generatePipecatService(operation: ProviderOperation, context: ExecutionContext): string {
  const configuration = canonicalJson({
    name: operation.resource,
    release: context.releaseId,
    environment: context.environment,
    config: operation.input,
  });
  return [
    "import json",
    "from pipecat.pipeline.pipeline import Pipeline",
    "from pipecat.pipeline.runner import PipelineRunner",
    "",
    `VOICEKIT_CONFIG = json.loads(${JSON.stringify(configuration)})`,
    "",
    "async def create_pipeline(processors):",
    "    return Pipeline(processors)",
    "",
    "async def run(processors):",
    "    pipeline = await create_pipeline(processors)",
    "    runner = PipelineRunner()",
    "    return await runner.run(pipeline)",
    "",
  ].join("\n");
}

function jsonStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : { value: value ?? null };
}
