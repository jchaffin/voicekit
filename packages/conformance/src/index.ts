export type Awaitable<T> = T | Promise<T>;

export interface AdapterCapabilities {
  readonly interruption: boolean;
  readonly tools: boolean;
  readonly reconnect: boolean;
  readonly cancellation: boolean;
  readonly usage: boolean;
  readonly rawEvents: boolean;
  readonly backpressure: boolean;
  readonly timeout: boolean;
  readonly audioHighWaterMark?: number;
}

export type NormalizedAdapterEvent =
  | { type: "connected"; resumed: boolean }
  | { type: "closed"; reason?: string }
  | { type: "speech.start" | "speech.end"; role: "user" | "assistant" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "audio"; audio: Uint8Array }
  | { type: "interrupted" }
  | { type: "tool.call"; callId: string; name: string; input: unknown }
  | { type: "tool.result"; callId: string; output?: unknown; error?: string }
  | { type: "cancelled"; operationId: string }
  | { type: "usage"; metric: string; quantity: number; unit: string }
  | { type: "raw"; raw: unknown }
  | { type: "error"; code: string; message: string };

export interface AdapterError extends Error {
  code: string;
  retryable?: boolean;
}

export interface ConformanceSession {
  readonly sessionId: string;
  readonly resumeToken?: string;
  onEvent(listener: (event: NormalizedAdapterEvent) => void): () => void;
  sendText(text: string): Awaitable<void>;
  sendAudio(audio: Uint8Array): Awaitable<void>;
  interrupt?(): Awaitable<void>;
  callTool?(call: { callId: string; name: string; input: unknown }): Awaitable<unknown>;
  reconnect?(resumeToken: string): Awaitable<void>;
  cancel?(operationId: string): Awaitable<void>;
  diagnostics?(): { readonly maxConcurrentAudioWrites?: number };
  close(): Awaitable<void>;
}

export interface ConnectOptions {
  auth?: string;
  resumeToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AdapterUnderTest {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  connect(options?: ConnectOptions): Awaitable<ConformanceSession>;
}

export interface ConformanceFixture {
  createAdapter(): Awaitable<AdapterUnderTest>;
  validAuth?: string;
  invalidAuth?: string;
  settle?: () => Awaitable<void>;
}

export type ConformanceCaseStatus = "passed" | "failed" | "skipped";

export interface ConformanceCaseResult {
  readonly suite: string;
  readonly name: string;
  readonly status: ConformanceCaseStatus;
  readonly durationMs: number;
  readonly error?: Error;
  readonly reason?: string;
}

export interface ConformanceCase {
  readonly name: string;
  readonly capability?: keyof AdapterCapabilities;
  run(fixture: ConformanceFixture): Promise<void>;
}

export interface AdapterSuite {
  readonly name: string;
  readonly cases: readonly ConformanceCase[];
}

export type SemanticEvent =
  | { readonly type: "listen.start" | "listen.stop" | "speak.start" | "speak.stop"; readonly turnId: string; readonly reason?: string }
  | { readonly type: "delegation.requested" | "delegation.started" | "delegation.completed" | "delegation.cancelled"; readonly delegationId: string }
  | { readonly type: "interruption"; readonly delegationId?: string }
  | { readonly type: "assignment"; readonly assignmentId: string; readonly variantId: string; readonly owner: "native" | "voicekit" }
  | { readonly type: "exposure"; readonly assignmentId: string; readonly exposureId: string; readonly deviation?: "fallback" }
  | { readonly type: "route"; readonly owner: "native" | "voicekit"; readonly branchId?: string }
  | { readonly type: "deployment"; readonly agentName: string; readonly deploymentName: string; readonly environment: "production" | "non-production" };

export interface SemanticFixture {
  run(scenario: string): Awaitable<readonly SemanticEvent[]>;
}

function semanticCase(name: string, scenario: string, verify: (events: readonly SemanticEvent[]) => void): ConformanceCase {
  return {
    name,
    async run(fixture) {
      const semantic = fixture as ConformanceFixture & Partial<SemanticFixture>;
      expect(typeof semantic.run === "function", "semantic fixture must implement run(scenario)");
      verify(await semantic.run(scenario));
    },
  };
}

const count = (events: readonly SemanticEvent[], type: SemanticEvent["type"]) =>
  events.filter((event) => event.type === type).length;

/** Offline contract for GPT-Live duplex and delegated Responses/client work. */
export const gptLiveSemanticsSuite: AdapterSuite = {
  name: "GPT-Live semantics",
  cases: [
    semanticCase("permits overlapping listening and speaking", "gpt-live/full-duplex", (events) => {
      const listen = events.findIndex((event) => event.type === "listen.start");
      const speak = events.findIndex((event) => event.type === "speak.start");
      const listenStop = events.findIndex((event) => event.type === "listen.stop");
      expect(listen >= 0 && speak > listen && (listenStop < 0 || speak < listenStop), "listening and speaking never overlapped");
    }),
    semanticCase("deduplicates delegation terminal events", "gpt-live/delegation-idempotency", (events) => {
      expect(count(events, "delegation.requested") === 1, "delegation was requested more than once");
      expect(count(events, "delegation.started") === 1, "delegation was started more than once");
      expect(count(events, "delegation.completed") === 1, "delegation completed more than once");
    }),
    semanticCase("cancels delegated work only when policy requests it", "gpt-live/interruption-cancellation", (events) => {
      expect(count(events, "interruption") === 1, "interruption was not reported exactly once");
      expect(count(events, "delegation.cancelled") === 1, "delegated backend cancellation was not idempotent");
      expect(count(events, "delegation.completed") === 0, "cancelled delegation later completed");
    }),
  ],
};

/** Offline contract for sticky assignment and exactly-once exposure/fallback accounting. */
export const experimentSemanticsSuite: AdapterSuite = {
  name: "experiment semantics",
  cases: [
    semanticCase("pins assignment across reconnect", "experiment/reconnect", (events) => {
      const assignments = events.filter((event): event is Extract<SemanticEvent, { type: "assignment" }> => event.type === "assignment");
      expect(assignments.length >= 2, "scenario must include initial and reconnect decisions");
      expect(assignments.every((event) => event.assignmentId === assignments[0]!.assignmentId && event.variantId === assignments[0]!.variantId), "reconnect changed assignment");
    }),
    semanticCase("records exposure once across retries", "experiment/exposure-idempotency", (events) => {
      expect(count(events, "exposure") === 1, "exposure retry produced duplicate ledger events");
    }),
    semanticCase("preserves intended assignment on fallback", "experiment/fallback", (events) => {
      const assignment = events.find((event): event is Extract<SemanticEvent, { type: "assignment" }> => event.type === "assignment");
      const exposure = events.find((event): event is Extract<SemanticEvent, { type: "exposure" }> => event.type === "exposure");
      expect(assignment && exposure?.assignmentId === assignment.assignmentId, "fallback replaced the assigned analysis unit");
      expect(exposure?.deviation === "fallback", "fallback exposure omitted its routing deviation");
    }),
  ],
};

/** Provider-native ElevenAgents owns branch choice; managed routing supplies it explicitly. */
export const elevenAgentsRoutingSuite: AdapterSuite = {
  name: "ElevenAgents routing ownership",
  cases: [
    semanticCase("native routing omits explicit branch", "elevenagents/native", (events) => {
      const route = events.find((event): event is Extract<SemanticEvent, { type: "route" }> => event.type === "route");
      expect(route?.owner === "native" && route.branchId === undefined, "native routing must not inject a managed branch");
    }),
    semanticCase("managed routing pins explicit branch", "elevenagents/managed", (events) => {
      const route = events.find((event): event is Extract<SemanticEvent, { type: "route" }> => event.type === "route");
      expect(route?.owner === "voicekit" && Boolean(route.branchId), "managed routing must identify its branch");
    }),
  ],
};

/** Named LiveKit deployment dispatch must retain agent, deployment, and environment. */
export const liveKitDeploymentSuite: AdapterSuite = {
  name: "LiveKit named deployment",
  cases: [semanticCase("round-trips named deployment descriptor", "livekit/named-deployment", (events) => {
    const deployment = events.find((event): event is Extract<SemanticEvent, { type: "deployment" }> => event.type === "deployment");
    expect(Boolean(deployment?.agentName), "deployment omitted agent name");
    expect(Boolean(deployment?.deploymentName), "deployment omitted deployment name");
    expect(deployment?.environment === "production" || deployment?.environment === "non-production", "deployment environment was invalid");
  })],
};

export const alpha1SemanticSuites: readonly AdapterSuite[] = Object.freeze([
  gptLiveSemanticsSuite,
  experimentSemanticsSuite,
  elevenAgentsRoutingSuite,
  liveKitDeploymentSuite,
]);

const settle = async (fixture: ConformanceFixture): Promise<void> => {
  await fixture.settle?.();
  await Promise.resolve();
};

const collect = (session: ConformanceSession) => {
  const events: NormalizedAdapterEvent[] = [];
  const off = session.onEvent((event) => events.push(event));
  return { events, off };
};

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(
  action: () => Awaitable<unknown>,
  predicate: (error: AdapterError) => boolean,
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && predicate(error as AdapterError)) return;
    throw new Error(`${message}: received ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  throw new Error(`${message}: operation resolved`);
}

async function connected(fixture: ConformanceFixture): Promise<{ adapter: AdapterUnderTest; session: ConformanceSession }> {
  const adapter = await fixture.createAdapter();
  const options = fixture.validAuth === undefined ? {} : { auth: fixture.validAuth };
  return { adapter, session: await adapter.connect(options) };
}

export const connectCloseSuite: AdapterSuite = {
  name: "connect/close",
  cases: [{
    name: "connects and closes idempotently",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.close();
      await session.close();
      await settle(fixture);
      expect(capture.events.filter((event) => event.type === "closed").length <= 1, "close emitted more than once");
      await expectReject(
        () => session.sendText("after close"),
        () => true,
        "send after close must reject",
      );
      capture.off();
    },
  }],
};

export const authNormalizationSuite: AdapterSuite = {
  name: "auth normalization",
  cases: [{
    name: "normalizes invalid credentials",
    async run(fixture) {
      expect(fixture.invalidAuth !== undefined, "fixture must provide invalidAuth");
      const adapter = await fixture.createAdapter();
      await expectReject(
        () => adapter.connect({ auth: fixture.invalidAuth! }),
        (error) => error.code === "AUTH_INVALID" && error.retryable === false,
        "invalid auth must reject with AUTH_INVALID and retryable=false",
      );
    },
  }],
};

export const eventOrderingSuite: AdapterSuite = {
  name: "event ordering",
  cases: [{
    name: "orders speech before final transcript",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.sendText("ordering-probe");
      await settle(fixture);
      const start = capture.events.findIndex((event) => event.type === "speech.start");
      const final = capture.events.findIndex((event) => event.type === "transcript" && event.final);
      const end = capture.events.findIndex((event) => event.type === "speech.end");
      expect(start >= 0 && final > start && end > final, "expected speech.start → final transcript → speech.end");
      capture.off();
      await session.close();
    },
  }],
};

export const interruptionSuite: AdapterSuite = {
  name: "interruption",
  cases: [{
    name: "emits interruption after interrupt",
    capability: "interruption",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.sendText("long-response");
      await session.interrupt!();
      await settle(fixture);
      expect(capture.events.some((event) => event.type === "interrupted"), "interrupt did not emit interrupted");
      capture.off();
      await session.close();
    },
  }],
};

export const toolDedupeSuite: AdapterSuite = {
  name: "tool dedupe",
  cases: [{
    name: "deduplicates repeated call ids",
    capability: "tools",
    async run(fixture) {
      const { session } = await connected(fixture);
      const call = { callId: "dedupe-1", name: "echo", input: { value: 1 } };
      const [first, second] = await Promise.all([session.callTool!(call), session.callTool!(call)]);
      expect(JSON.stringify(first) === JSON.stringify(second), "duplicate tool calls returned different values");
    },
  }],
};

export const reconnectResumeSuite: AdapterSuite = {
  name: "reconnect/resume",
  cases: [{
    name: "resumes the same session",
    capability: "reconnect",
    async run(fixture) {
      const { session } = await connected(fixture);
      expect(Boolean(session.resumeToken), "reconnect-capable session must expose resumeToken");
      const original = session.sessionId;
      await session.reconnect!(session.resumeToken!);
      await settle(fixture);
      expect(session.sessionId === original, "resume changed session identity");
      await session.close();
    },
  }],
};

export const cancellationSuite: AdapterSuite = {
  name: "cancellation",
  cases: [{
    name: "cancels an operation and reports it",
    capability: "cancellation",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.cancel!("operation-1");
      await settle(fixture);
      expect(
        capture.events.some((event) => event.type === "cancelled" && event.operationId === "operation-1"),
        "cancel did not identify the operation",
      );
      capture.off();
      await session.close();
    },
  }],
};

export const usageSuite: AdapterSuite = {
  name: "usage",
  cases: [{
    name: "emits non-negative normalized usage",
    capability: "usage",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.sendAudio(new Uint8Array([1, 2, 3, 4]));
      await settle(fixture);
      const usage = capture.events.filter((event): event is Extract<NormalizedAdapterEvent, { type: "usage" }> => event.type === "usage");
      expect(usage.length > 0, "no usage event emitted");
      expect(usage.every((event) => event.quantity >= 0 && event.metric.length > 0 && event.unit.length > 0), "usage was not normalized");
      capture.off();
      await session.close();
    },
  }],
};

export const rawEventsSuite: AdapterSuite = {
  name: "raw events",
  cases: [{
    name: "retains unmapped provider events",
    capability: "rawEvents",
    async run(fixture) {
      const { session } = await connected(fixture);
      const capture = collect(session);
      await session.sendText("raw-probe");
      await settle(fixture);
      expect(capture.events.some((event) => event.type === "raw"), "unmapped provider event was dropped");
      capture.off();
      await session.close();
    },
  }],
};

export const backpressureSuite: AdapterSuite = {
  name: "backpressure",
  cases: [{
    name: "bounds concurrent audio writes",
    capability: "backpressure",
    async run(fixture) {
      const { adapter, session } = await connected(fixture);
      const highWaterMark = adapter.capabilities.audioHighWaterMark;
      expect(
        Number.isInteger(highWaterMark) && highWaterMark! > 0,
        "backpressure-capable adapter must declare audioHighWaterMark",
      );
      const writes = Array.from({ length: 32 }, (_, index) => session.sendAudio(new Uint8Array([index])));
      await Promise.all(writes);
      const maximum = session.diagnostics?.().maxConcurrentAudioWrites;
      expect(maximum !== undefined, "backpressure suite requires maxConcurrentAudioWrites diagnostics");
      expect(maximum <= highWaterMark!, `audio writes exceeded high-water mark (${maximum} > ${highWaterMark})`);
      await session.close();
    },
  }],
};

export const timeoutSuite: AdapterSuite = {
  name: "timeout",
  cases: [{
    name: "normalizes connect timeout",
    capability: "timeout",
    async run(fixture) {
      const adapter = await fixture.createAdapter();
      const options: ConnectOptions = { timeoutMs: 0 };
      if (fixture.validAuth !== undefined) options.auth = fixture.validAuth;
      await expectReject(
        () => adapter.connect(options),
        (error) => error.code === "TIMEOUT" && error.retryable === true,
        "timeout must reject with TIMEOUT and retryable=true",
      );
    },
  }],
};

export const declaredCapabilitiesSuite: AdapterSuite = {
  name: "declared capabilities",
  cases: [{
    name: "capability declarations match methods",
    async run(fixture) {
      const { adapter, session } = await connected(fixture);
      const methodByCapability: Partial<Record<keyof AdapterCapabilities, keyof ConformanceSession>> = {
        interruption: "interrupt",
        tools: "callTool",
        reconnect: "reconnect",
        cancellation: "cancel",
      };
      for (const [capability, method] of Object.entries(methodByCapability) as [keyof AdapterCapabilities, keyof ConformanceSession][]) {
        expect(adapter.capabilities[capability] === (typeof session[method] === "function"), `${capability} declaration does not match ${method}`);
      }
      await session.close();
    },
  }],
};

export const adapterSuites: readonly AdapterSuite[] = Object.freeze([
  connectCloseSuite,
  authNormalizationSuite,
  eventOrderingSuite,
  interruptionSuite,
  toolDedupeSuite,
  reconnectResumeSuite,
  cancellationSuite,
  usageSuite,
  rawEventsSuite,
  backpressureSuite,
  timeoutSuite,
  declaredCapabilitiesSuite,
]);

export async function runAdapterSuites(
  fixture: ConformanceFixture,
  suites: readonly AdapterSuite[] = adapterSuites,
): Promise<readonly ConformanceCaseResult[]> {
  const results: ConformanceCaseResult[] = [];
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const startedAt = performance.now();
      let adapter: AdapterUnderTest | undefined;
      if (testCase.capability) adapter = await fixture.createAdapter();
      if (testCase.capability && !adapter!.capabilities[testCase.capability]) {
        results.push({
          suite: suite.name,
          name: testCase.name,
          status: "skipped",
          durationMs: performance.now() - startedAt,
          reason: `capability "${testCase.capability}" is not declared`,
        });
        continue;
      }
      try {
        await testCase.run(fixture);
        results.push({ suite: suite.name, name: testCase.name, status: "passed", durationMs: performance.now() - startedAt });
      } catch (cause) {
        results.push({
          suite: suite.name,
          name: testCase.name,
          status: "failed",
          durationMs: performance.now() - startedAt,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
  }
  return results;
}

export interface CertificationEntry {
  readonly id: string;
  readonly adapter: string;
  readonly secretReferences: readonly string[];
  readonly createFixture: (secrets: Readonly<Record<string, string>>) => Awaitable<ConformanceFixture>;
  readonly suites?: readonly AdapterSuite[];
}

export interface CertificationResult {
  readonly id: string;
  readonly adapter: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly reason?: string;
  readonly cases: readonly ConformanceCaseResult[];
}

export class CertificationRegistry {
  readonly #entries = new Map<string, CertificationEntry>();

  register(entry: CertificationEntry): this {
    if (!entry.id.trim()) throw new TypeError("Certification id must not be empty");
    if (this.#entries.has(entry.id)) throw new TypeError(`Duplicate certification id "${entry.id}"`);
    this.#entries.set(entry.id, Object.freeze({ ...entry, secretReferences: Object.freeze([...entry.secretReferences]) }));
    return this;
  }

  list(): readonly CertificationEntry[] { return [...this.#entries.values()]; }
  get(id: string): CertificationEntry | undefined { return this.#entries.get(id); }
}

export async function runCertifications(
  registry: CertificationRegistry,
  options: { secrets?: Readonly<Record<string, string | undefined>>; ids?: readonly string[] } = {},
): Promise<readonly CertificationResult[]> {
  const selected = options.ids
    ? options.ids.map((id) => registry.get(id)).filter((entry): entry is CertificationEntry => Boolean(entry))
    : registry.list();
  const output: CertificationResult[] = [];
  for (const entry of selected) {
    const missing = entry.secretReferences.filter((reference) => !options.secrets?.[reference]);
    if (missing.length) {
      output.push({
        id: entry.id,
        adapter: entry.adapter,
        status: "skipped",
        reason: `missing secret references: ${missing.join(", ")}`,
        cases: [],
      });
      continue;
    }
    const secrets = Object.fromEntries(entry.secretReferences.map((reference) => [reference, options.secrets![reference]!]));
    try {
      const cases = await runAdapterSuites(await entry.createFixture(secrets), entry.suites);
      output.push({
        id: entry.id,
        adapter: entry.adapter,
        status: cases.some((result) => result.status === "failed") ? "failed" : "passed",
        cases,
      });
    } catch (cause) {
      output.push({
        id: entry.id,
        adapter: entry.adapter,
        status: "failed",
        reason: cause instanceof Error ? cause.message : String(cause),
        cases: [],
      });
    }
  }
  return output;
}
