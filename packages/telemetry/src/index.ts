export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;

export interface Context {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string;
  baggage?: Readonly<Record<string, string>>;
}

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = { code: "unset" | "ok" | "error"; message?: string };

export interface SpanEvent {
  name: string;
  time: number;
  attributes?: Attributes;
}

export interface SpanData {
  name: string;
  context: Context;
  parent?: Context;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Attributes;
  events: readonly SpanEvent[];
  resource: Attributes;
  instrumentationScope: { name: string; version?: string };
}

export interface Span {
  readonly context: Context;
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attributes: Attributes): this;
  addEvent(name: string, attributes?: Attributes, time?: number): this;
  recordException(error: unknown): this;
  setStatus(status: SpanStatus): this;
  end(endTime?: number): void;
}

export interface SpanOptions {
  parent?: Context;
  kind?: SpanKind;
  startTime?: number;
  attributes?: Attributes;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  withSpan<T>(name: string, operation: (span: Span) => T | Promise<T>, options?: SpanOptions): Promise<T>;
}

export interface MetricPoint {
  name: string;
  type: "counter" | "histogram" | "gauge";
  value: number;
  time: number;
  attributes: Attributes;
  resource: Attributes;
  instrumentationScope: { name: string; version?: string };
}

export interface Counter {
  add(value?: number, attributes?: Attributes): void;
}
export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}
export interface Gauge {
  record(value: number, attributes?: Attributes): void;
}
export interface Meter {
  createCounter(name: string): Counter;
  createHistogram(name: string): Histogram;
  createGauge(name: string): Gauge;
}

export interface TelemetryBatch {
  spans: readonly SpanData[];
  metrics: readonly MetricPoint[];
}

/** Accepts OTel-shaped records and can bridge to an OTLP HTTP/gRPC client. */
export interface TelemetryExporter {
  export(batch: TelemetryBatch): Promise<void>;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface OtlpTransport {
  send(signal: "traces" | "metrics", payload: unknown): Promise<void>;
}

export interface RedactionOptions {
  redactKeys?: readonly (string | RegExp)[];
  allowKeys?: readonly (string | RegExp)[];
  redactText?: boolean;
  replacement?: string;
  transform?: (key: string, value: AttributeValue) => AttributeValue | undefined;
}

const DEFAULT_SENSITIVE = [
  /audio/i, /transcript/i, /prompt/i, /response/i, /content/i, /message/i,
  /email/i, /phone/i, /token/i, /secret/i, /authorization/i, /cookie/i,
];

export class PrivacyRedactor {
  private readonly sensitive: readonly (string | RegExp)[];
  private readonly allowed: readonly (string | RegExp)[];
  private readonly replacement: string;
  constructor(private readonly options: RedactionOptions = {}) {
    this.sensitive = options.redactKeys ?? DEFAULT_SENSITIVE;
    this.allowed = options.allowKeys ?? [];
    this.replacement = options.replacement ?? "[REDACTED]";
  }

  attributes(attributes: Attributes = {}): Attributes {
    const result: Record<string, AttributeValue> = {};
    for (const [key, raw] of Object.entries(attributes)) {
      if (raw === undefined) continue;
      const transformed = this.options.transform?.(key, raw);
      if (this.options.transform && transformed === undefined) continue;
      const value = transformed ?? raw;
      const allowed = this.allowed.some((entry) => matches(entry, key));
      const sensitive = this.sensitive.some((entry) => matches(entry, key));
      result[key] = !allowed && (sensitive || (this.options.redactText !== false && key.endsWith(".text")))
        ? this.replacement
        : value;
    }
    return result;
  }
}

function matches(pattern: string | RegExp, value: string): boolean {
  if (typeof pattern === "string") return pattern === value;
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export const VoiceSpan = {
  session: "voicekit.session",
  turn: "voicekit.turn",
  stt: "voicekit.stt",
  model: "voicekit.model",
  tts: "voicekit.tts",
  playback: "voicekit.playback",
  policy: "voicekit.policy",
  tool: "voicekit.tool",
  handoff: "voicekit.handoff",
} as const;

export const VoiceMetric = {
  sessions: "voicekit.sessions",
  turns: "voicekit.turns",
  latency: "voicekit.operation.duration",
  errors: "voicekit.errors",
  audioDuration: "voicekit.audio.duration",
  tokens: "voicekit.model.tokens",
  toolCalls: "voicekit.tool.calls",
  handoffs: "voicekit.handoffs",
} as const;

export type VoiceOperation = keyof typeof VoiceSpan;

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  release?: string;
  environment?: string;
  provider?: string;
  resource?: Attributes;
  exporters?: readonly TelemetryExporter[];
  redaction?: RedactionOptions;
  clock?: () => number;
  randomId?: (bytes: number) => string;
}

export class VoiceTelemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
  private readonly exporters: readonly TelemetryExporter[];
  private readonly pending = new Set<Promise<void>>();

  constructor(options: TelemetryOptions) {
    this.exporters = options.exporters ?? [];
    const resource: Attributes = {
      "service.name": options.serviceName,
      "service.version": options.serviceVersion,
      "deployment.environment.name": options.environment,
      "voicekit.release": options.release,
      "voicekit.provider": options.provider,
      ...options.resource,
    };
    const redactor = new PrivacyRedactor(options.redaction);
    const clock = options.clock ?? Date.now;
    const id = options.randomId ?? randomHex;
    const scope = optionalVersion({ name: "@jchaffin/voicekit-telemetry" }, options.serviceVersion);
    const emitSpan = (span: SpanData) => this.dispatch({ spans: [span], metrics: [] });
    const emitMetric = (metric: MetricPoint) => this.dispatch({ spans: [], metrics: [metric] });
    this.tracer = new BasicTracer(resource, scope, redactor, clock, id, emitSpan);
    this.meter = new BasicMeter(resource, scope, redactor, clock, emitMetric);
  }

  start(operation: VoiceOperation, options: SpanOptions = {}): Span {
    return this.tracer.startSpan(VoiceSpan[operation], options);
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.pending]);
    await Promise.all(this.exporters.map((exporter) => exporter.forceFlush?.()));
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await Promise.all(this.exporters.map((exporter) => exporter.shutdown?.()));
  }

  private dispatch(batch: TelemetryBatch): void {
    for (const exporter of this.exporters) {
      const operation = exporter.export(batch);
      this.pending.add(operation);
      void operation.then(
        () => this.pending.delete(operation),
        () => this.pending.delete(operation),
      );
    }
  }
}

class BasicTracer implements Tracer {
  constructor(
    private readonly resource: Attributes,
    private readonly scope: { name: string; version?: string },
    private readonly redactor: PrivacyRedactor,
    private readonly clock: () => number,
    private readonly id: (bytes: number) => string,
    private readonly emit: (span: SpanData) => void,
  ) {}

  startSpan(name: string, options: SpanOptions = {}): Span {
    const context: Context = { traceId: options.parent?.traceId ?? this.id(16), spanId: this.id(8), traceFlags: 1 };
    return new BasicSpan(name, context, options, this.resource, this.scope, this.redactor, this.clock, this.emit);
  }

  async withSpan<T>(name: string, operation: (span: Span) => T | Promise<T>, options?: SpanOptions): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await operation(span);
      span.setStatus({ code: "ok" });
      return result;
    } catch (error) {
      span.recordException(error).setStatus({ code: "error", message: errorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  }
}

class BasicSpan implements Span {
  private readonly attributes: Record<string, AttributeValue> = {};
  private readonly events: SpanEvent[] = [];
  private status: SpanStatus = { code: "unset" };
  private ended = false;
  private readonly startTime: number;
  readonly context: Context;

  constructor(
    private readonly name: string,
    context: Context,
    private readonly options: SpanOptions,
    private readonly resource: Attributes,
    private readonly scope: { name: string; version?: string },
    private readonly redactor: PrivacyRedactor,
    private readonly clock: () => number,
    private readonly emit: (span: SpanData) => void,
  ) {
    this.context = context;
    this.startTime = options.startTime ?? clock();
    this.setAttributes(options.attributes ?? {});
  }

  setAttribute(key: string, value: AttributeValue): this { this.attributes[key] = value; return this; }
  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) if (value !== undefined) this.attributes[key] = value;
    return this;
  }
  addEvent(name: string, attributes?: Attributes, time = this.clock()): this {
    this.events.push({ name, time, ...(attributes ? { attributes: this.redactor.attributes(attributes) } : {}) });
    return this;
  }
  recordException(error: unknown): this {
    const exception = error instanceof Error ? error : new Error(String(error));
    return this.addEvent("exception", {
      "exception.type": exception.name,
      "exception.message": exception.message,
      "exception.stacktrace": exception.stack ?? "",
    });
  }
  setStatus(status: SpanStatus): this { this.status = status; return this; }
  end(endTime = this.clock()): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({
      name: this.name, context: this.context,
      ...(this.options.parent ? { parent: this.options.parent } : {}),
      kind: this.options.kind ?? "internal",
      startTime: this.startTime, endTime, durationMs: Math.max(0, endTime - this.startTime),
      status: this.status, attributes: this.redactor.attributes(this.attributes),
      events: this.events, resource: this.resource, instrumentationScope: this.scope,
    });
  }
}

class BasicMeter implements Meter {
  constructor(
    private readonly resource: Attributes,
    private readonly scope: { name: string; version?: string },
    private readonly redactor: PrivacyRedactor,
    private readonly clock: () => number,
    private readonly emit: (point: MetricPoint) => void,
  ) {}
  createCounter(name: string): Counter { return { add: (value = 1, attributes) => this.record(name, "counter", value, attributes) }; }
  createHistogram(name: string): Histogram { return { record: (value, attributes) => this.record(name, "histogram", value, attributes) }; }
  createGauge(name: string): Gauge { return { record: (value, attributes) => this.record(name, "gauge", value, attributes) }; }
  private record(name: string, type: MetricPoint["type"], value: number, attributes?: Attributes): void {
    if (!Number.isFinite(value)) throw new TypeError("Metric values must be finite");
    this.emit({ name, type, value, time: this.clock(), attributes: this.redactor.attributes(attributes), resource: this.resource, instrumentationScope: this.scope });
  }
}

export class MemoryExporter implements TelemetryExporter {
  readonly spans: SpanData[] = [];
  readonly metrics: MetricPoint[] = [];
  async export(batch: TelemetryBatch): Promise<void> {
    this.spans.push(...batch.spans);
    this.metrics.push(...batch.metrics);
  }
  reset(): void { this.spans.length = 0; this.metrics.length = 0; }
}

export class ConsoleExporter implements TelemetryExporter {
  constructor(private readonly logger: Pick<Console, "log"> = console) {}
  async export(batch: TelemetryBatch): Promise<void> {
    for (const span of batch.spans) this.logger.log(JSON.stringify({ signal: "trace", ...span }));
    for (const metric of batch.metrics) this.logger.log(JSON.stringify({ signal: "metric", ...metric }));
  }
}

export class OtlpExporter implements TelemetryExporter {
  constructor(private readonly transport: OtlpTransport) {}
  async export(batch: TelemetryBatch): Promise<void> {
    const operations: Promise<void>[] = [];
    if (batch.spans.length) operations.push(this.transport.send("traces", { resourceSpans: toResourceSpans(batch.spans) }));
    if (batch.metrics.length) operations.push(this.transport.send("metrics", { resourceMetrics: toResourceMetrics(batch.metrics) }));
    await Promise.all(operations);
  }
}

function toResourceSpans(spans: readonly SpanData[]): unknown[] {
  return [{ resource: { attributes: otlpAttributes(spans[0]?.resource ?? {}) }, scopeSpans: [{ scope: spans[0]?.instrumentationScope, spans: spans.map((span) => ({
    traceId: span.context.traceId, spanId: span.context.spanId, parentSpanId: span.parent?.spanId, name: span.name,
    kind: otlpSpanKind(span.kind), startTimeUnixNano: millisToNanos(span.startTime), endTimeUnixNano: millisToNanos(span.endTime),
    attributes: otlpAttributes(span.attributes), events: span.events.map((event) => ({ name: event.name, timeUnixNano: millisToNanos(event.time), attributes: otlpAttributes(event.attributes ?? {}) })),
    status: { code: span.status.code === "error" ? 2 : span.status.code === "ok" ? 1 : 0, ...(span.status.message === undefined ? {} : { message: span.status.message }) },
  })) }] }];
}

function toResourceMetrics(metrics: readonly MetricPoint[]): unknown[] {
  return [{ resource: { attributes: otlpAttributes(metrics[0]?.resource ?? {}) }, scopeMetrics: [{ scope: metrics[0]?.instrumentationScope, metrics: metrics.map((metric) => ({
    name: metric.name, ...otlpMetricData(metric),
  })) }] }];
}

function otlpAttributes(attributes: Attributes): unknown[] {
  return Object.entries(attributes).filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}
function otlpAnyValue(value: AttributeValue): unknown {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => otlpAnyValue(item)) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
function otlpMetricData(metric: MetricPoint): Record<string, unknown> {
  const point = { asDouble: metric.value, timeUnixNano: millisToNanos(metric.time), attributes: otlpAttributes(metric.attributes) };
  if (metric.type === "counter") return { sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [point] } };
  if (metric.type === "gauge") return { gauge: { dataPoints: [point] } };
  return { histogram: { aggregationTemporality: 1, dataPoints: [{ ...point, count: "1", sum: metric.value, bucketCounts: ["1"], explicitBounds: [] }] } };
}
function otlpSpanKind(kind: SpanKind): number {
  return { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 }[kind];
}
function millisToNanos(value: number): string { return BigInt(Math.trunc(value * 1_000_000)).toString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function optionalVersion(base: { name: string }, version: string | undefined): { name: string; version?: string } {
  return version === undefined ? base : { ...base, version };
}
function randomHex(bytes: number): string {
  let value = "";
  for (let index = 0; index < bytes; index += 1) value += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return value;
}
