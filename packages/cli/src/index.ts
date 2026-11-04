import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DeploymentEngine,
  ElevenLabsAdapter,
  LiveKitCloudAdapter,
  ManagedProviderAdapter,
  PipecatServiceAdapter,
  VercelAdapter,
  defineDeployment,
  planDeployment,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type DeploymentDefinition,
  type DeploymentEngineOptions,
  type EnvironmentName,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type JsonValue,
  type OperationLedgerEntry,
  type ProviderAdapter,
  type ReleaseLedger,
  type ReleaseRecord,
  type SecretResolver,
} from "@jchaffin/voicekit-deploy";

export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
  Drift: 3,
  NotFound: 4,
} as const;

type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
type CommandName = "plan" | "deploy" | "status" | "logs" | "test" | "rollback";

export interface CliOptions {
  readonly command: CommandName;
  readonly config: string;
  readonly environment: EnvironmentName;
  readonly ledger: string;
  readonly json: boolean;
  readonly approve: boolean;
  readonly drift: boolean;
  readonly release?: string;
  readonly provider?: string;
  readonly resource?: string;
}

export interface CliIO {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliDependencies {
  readonly cwd?: string;
  readonly io?: CliIO;
  readonly loadConfig?: (path: string) => Promise<DeploymentDefinition>;
  readonly createEngine?: (
    definition: DeploymentDefinition,
    environment: EnvironmentName,
    ledger: ReleaseLedger,
    options: CliOptions,
  ) => DeploymentEngine;
  readonly ledger?: ReleaseLedger;
}

const HELP = `voicekit <command> [options]

Commands:
  plan       Build and print an immutable provider operation plan
  deploy     Start or resume a release
  status     Print release status; add --drift to inspect providers
  logs       Print provider logs for a release resource
  test       Run a provider smoke test for a release resource
  rollback   Compensate a release in reverse operation order

Options:
  --config <path>       Config module or JSON (default voicekit.config.js)
  --env <preview|prod>
  --release <id>        Release id (required except plan and new deploy)
  --ledger <path>       Release ledger JSON path
  --provider <name>     Provider for logs/test
  --resource <id>       Resource for logs/test
  --approve             Pass manual approval gates
  --drift               Include drift check with status
  --json                Emit machine-readable JSON
  -h, --help            Show help`;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseArgs(argv: readonly string[], cwd = process.cwd()): CliOptions {
  const [commandValue, ...tokens] = argv;
  if (!commandValue || commandValue === "--help" || commandValue === "-h") throw new CliUsageError(HELP);
  if (!["plan", "deploy", "status", "logs", "test", "rollback"].includes(commandValue)) {
    throw new CliUsageError(`Unknown command "${commandValue}"\n\n${HELP}`);
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["config", "env", "release", "ledger", "provider", "resource"]);
  const flagOptions = new Set(["json", "approve", "drift"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-h" || token === "--help") throw new CliUsageError(HELP);
    if (!token.startsWith("--")) throw new CliUsageError(`Unexpected argument "${token}"`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    const name = rawName!;
    if (flagOptions.has(name)) {
      if (inline !== undefined) throw new CliUsageError(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new CliUsageError(`Unknown option "--${name}"`);
    const value = inline ?? tokens[++index];
    if (!value || value.startsWith("--")) throw new CliUsageError(`--${name} requires a value`);
    if (values.has(name)) throw new CliUsageError(`--${name} may be specified only once`);
    values.set(name, value);
  }
  const environment = values.get("env") ?? "preview";
  if (environment !== "preview" && environment !== "prod") {
    throw new CliUsageError('--env must be "preview" or "prod"');
  }
  const command = commandValue as CommandName;
  if (["status", "logs", "test", "rollback"].includes(command) && !values.get("release")) {
    throw new CliUsageError(`--release is required for ${command}`);
  }
  if (["logs", "test"].includes(command) && (!values.get("provider") || !values.get("resource"))) {
    throw new CliUsageError(`--provider and --resource are required for ${command}`);
  }
  return {
    command,
    config: resolve(cwd, values.get("config") ?? "voicekit.config.js"),
    environment,
    ledger: resolve(cwd, values.get("ledger") ?? ".voicekit/releases.json"),
    json: flags.has("json"),
    approve: flags.has("approve"),
    drift: flags.has("drift"),
    ...(values.get("release") ? { release: values.get("release")! } : {}),
    ...(values.get("provider") ? { provider: values.get("provider")! } : {}),
    ...(values.get("resource") ? { resource: values.get("resource")! } : {}),
  };
}

export async function loadDeploymentConfig(path: string): Promise<DeploymentDefinition> {
  const absolute = resolve(path);
  const extension = extname(absolute);
  if (![".json", ".js", ".mjs", ".cjs"].includes(extension)) {
    throw new Error(`Unsupported config extension "${extension}"; use .json, .js, .mjs, or .cjs`);
  }
  let value: unknown;
  if (extension === ".json") {
    value = JSON.parse(await readFile(absolute, "utf8"));
  } else {
    // file: URLs avoid import specifier injection; no eval or shell is involved.
    const module = await import(`${pathToFileURL(absolute).href}?voicekit=${Date.now()}`);
    value = module.default ?? module.deployment;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Config must export a deployment object as default or named `deployment`");
  }
  const record = value as Record<string, unknown>;
  const input = record.schemaVersion
    ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "schemaVersion"))
    : record;
  return defineDeployment(input as unknown as Parameters<typeof defineDeployment>[0]);
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<ExitCodeValue> {
  const cwd = dependencies.cwd ?? process.cwd();
  const io = dependencies.io ?? {
    stdout: (value: string) => process.stdout.write(`${value}\n`),
    stderr: (value: string) => process.stderr.write(`${value}\n`),
  };
  let options: CliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return ExitCode.Usage;
  }
  try {
    const definition = await (dependencies.loadConfig ?? loadDeploymentConfig)(options.config);
    const artifact = planDeployment(definition, options.environment);
    if (options.command === "plan") {
      print(io, options.json, artifact, [
        `Deployment: ${artifact.manifest.deployment}`,
        `Environment: ${artifact.manifest.environment}`,
        `Digest: ${artifact.digest}`,
        ...artifact.manifest.operations.map(
          (operation) => `${operation.id}: ${operation.provider}/${operation.action} (${operation.phase})`,
        ),
      ]);
      return ExitCode.Success;
    }
    const ledger = dependencies.ledger ?? new FileReleaseLedger(options.ledger);
    const engine = dependencies.createEngine
      ? dependencies.createEngine(definition, options.environment, ledger, options)
      : createDefaultEngine(definition, options.environment, ledger, options);
    if (options.command === "deploy") {
      const release = await engine.deploy(artifact, options.release);
      printRelease(io, options.json, release);
      return ExitCode.Success;
    }
    if (options.command === "rollback") {
      const release = await engine.rollback(artifact, options.release!);
      printRelease(io, options.json, release);
      return ExitCode.Success;
    }
    if (options.command === "status") {
      const release = await engine.status(options.release!);
      if (!release) {
        io.stderr(`Release "${options.release}" was not found`);
        return ExitCode.NotFound;
      }
      if (options.drift) {
        const drift = await engine.drift(artifact, release.id);
        print(io, options.json, { release, drift }, [
          ...releaseLines(release),
          ...drift.map((item) => `drift ${item.operationId}: ${item.state}`),
        ]);
        return drift.some(({ state }) => state === "changed" || state === "missing")
          ? ExitCode.Drift
          : ExitCode.Success;
      }
      printRelease(io, options.json, release);
      return ExitCode.Success;
    }
    if (options.command === "logs") {
      const lines = await engine.logs(options.provider!, options.resource!, options.release!);
      print(io, options.json, { logs: lines }, lines);
      return ExitCode.Success;
    }
    const result = await engine.test(options.provider!, options.resource!, options.release!);
    print(io, options.json, result, [`Test passed for ${options.provider}/${options.resource}`]);
    return ExitCode.Success;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return ExitCode.Failure;
  }
}

export class FileReleaseLedger implements ReleaseLedger {
  readonly path: string;
  #write = Promise.resolve();
  constructor(path: string) {
    this.path = resolve(path);
  }
  async create(record: ReleaseRecord): Promise<void> {
    await this.#mutate((records) => {
      if (records[record.id]) throw new Error(`Release "${record.id}" already exists`);
      records[record.id] = record;
    });
  }
  async get(releaseId: string): Promise<ReleaseRecord | undefined> {
    const record = (await this.#read())[releaseId];
    return record ? structuredClone(record) : undefined;
  }
  async update(record: ReleaseRecord): Promise<void> {
    await this.#mutate((records) => {
      if (!records[record.id]) throw new Error(`Release "${record.id}" was not found`);
      records[record.id] = record;
    });
  }
  async getOperation(releaseId: string, operationId: string): Promise<OperationLedgerEntry | undefined> {
    const entry = (await this.#read())[releaseId]?.operations[operationId];
    return entry ? structuredClone(entry) : undefined;
  }
  async putOperation(releaseId: string, entry: OperationLedgerEntry): Promise<void> {
    await this.#mutate((records) => {
      const release = records[releaseId];
      if (!release) throw new Error(`Release "${releaseId}" was not found`);
      records[releaseId] = {
        ...release,
        operations: { ...release.operations, [entry.operationId]: entry },
      };
    });
  }
  async list(deployment?: string, environment?: EnvironmentName): Promise<readonly ReleaseRecord[]> {
    return Object.values(await this.#read()).filter(
      (record) => (!deployment || record.deployment === deployment) && (!environment || record.environment === environment),
    );
  }
  async #read(): Promise<Record<string, ReleaseRecord>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger root must be an object");
      return value as Record<string, ReleaseRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Cannot read release ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async #mutate(change: (records: Record<string, ReleaseRecord>) => void): Promise<void> {
    const operation = this.#write.then(async () => {
      const records = await this.#read();
      change(records);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.#write = operation.catch(() => undefined);
    return operation;
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env ? { ...process.env, ...request.env } : process.env,
        shell: false,
        stdio: "pipe",
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(request.stdin);
    });
  }
}

export class FetchHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { "content-type": "application/json", ...request.headers },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const text = await response.text();
    let body: JsonValue | undefined;
    if (text) {
      try {
        body = JSON.parse(text) as JsonValue;
      } catch {
        body = text;
      }
    }
    return { status: response.status, ...(body !== undefined ? { body } : {}) };
  }
}

export function createDefaultEngine(
  definition: DeploymentDefinition,
  environment: EnvironmentName,
  ledger: ReleaseLedger,
  options: CliOptions,
): DeploymentEngine {
  const runner = new NodeCommandRunner();
  const http = new FetchHttpClient();
  const adapters: Record<string, ProviderAdapter> = {
    vercel: new VercelAdapter(runner),
    livekit: new LiveKitCloudAdapter(runner),
    elevenlabs: new ElevenLabsAdapter(http),
    pipecat: new PipecatServiceAdapter(runner),
  };
  const providerConfig = definition.environments[environment].providers ?? {};
  for (const resource of definition.resources) {
    if (adapters[resource.provider]) continue;
    const baseUrl = providerConfig[resource.provider]?.baseUrl;
    if (typeof baseUrl !== "string") {
      throw new Error(`Managed provider "${resource.provider}" requires providers.${resource.provider}.baseUrl`);
    }
    adapters[resource.provider] = new ManagedProviderAdapter(resource.provider, http, baseUrl);
  }
  const secrets: SecretResolver = {
    async resolve(name: string): Promise<string> {
      const value = process.env[name];
      if (!value) throw new Error(`Secret "${name}" is not available in the environment`);
      return value;
    },
  };
  const engineOptions: DeploymentEngineOptions = {
    adapters,
    ledger,
    secrets,
    gates: {
      async evaluate(gate, context) {
        if (gate.type === "approval") {
          return options.approve
            ? { passed: true, detail: "approved by CLI flag" }
            : { passed: false, detail: `Gate "${gate.id}" requires --approve` };
        }
        if (!gate.resource) return { passed: false, detail: `Gate "${gate.id}" requires a resource` };
        const resource = definition.resources.find(({ id }) => id === gate.resource);
        if (!resource) return { passed: false, detail: `Gate resource "${gate.resource}" was not found` };
        const adapter = adapters[resource.provider];
        if (!adapter?.test) return { passed: false, detail: `Provider "${resource.provider}" does not support tests` };
        await adapter.test(resource.id, context);
        return { passed: true };
      },
    },
  };
  return new DeploymentEngine(engineOptions);
}

function print(io: CliIO, json: boolean, value: unknown, lines: readonly string[]): void {
  io.stdout(json ? JSON.stringify(value, null, 2) : lines.join("\n"));
}

function printRelease(io: CliIO, json: boolean, release: ReleaseRecord): void {
  print(io, json, release, releaseLines(release));
}

function releaseLines(release: ReleaseRecord): string[] {
  return [
    `Release: ${release.id}`,
    `State: ${release.state}`,
    `Deployment: ${release.deployment} (${release.environment})`,
    ...Object.values(release.operations).map((operation) => `${operation.operationId}: ${operation.state}`),
    ...(release.error ? [`Error: ${release.error}`] : []),
  ];
}
