export type Awaitable<T> = T | Promise<T>;

export interface StageContext {
  readonly signal: AbortSignal;
  readonly stage: string;
  readonly attempt: number;
  readonly metadata: Map<string, unknown>;
}

export interface PipelineStage<I, O> {
  readonly name: string;
  process(input: I, context: StageContext): Awaitable<O | AsyncIterable<O>>;
  close?(): Awaitable<void>;
  raw?: unknown;
}

export interface PipelineTiming {
  stage: string;
  provider: string;
  attempt: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  error?: Error;
}

export interface PipelineOptions {
  signal?: AbortSignal;
  highWaterMark?: number;
  now?: () => number;
  onTiming?: (timing: PipelineTiming) => void;
  onFallback?: (event: { stage: string; from: string; to: string; error: Error }) => void;
}

export class PipelineProviderError extends Error {
  readonly stage: string;
  readonly errors: readonly { provider: string; error: Error }[];

  constructor(
    stage: string,
    errors: readonly { provider: string; error: Error }[],
  ) {
    super(`All providers failed for stage "${stage}": ${errors.map(({ provider }) => provider).join(", ")}`);
    this.name = "PipelineProviderError";
    this.stage = stage;
    this.errors = errors;
  }
}

export function withFallback<I, O>(
  name: string,
  providers: readonly PipelineStage<I, O>[],
): PipelineStage<I, O> {
  if (!providers.length) throw new TypeError(`Fallback stage "${name}" needs at least one provider`);
  return {
    name,
    raw: providers.map((provider) => provider.raw ?? provider),
    async process(input, context) {
      const failures: { provider: string; error: Error }[] = [];
      for (let index = 0; index < providers.length; index++) {
        const provider = providers[index]!;
        throwIfAborted(context.signal);
        try {
          return await provider.process(input, { ...context, stage: name, attempt: index + 1 });
        } catch (cause) {
          const error = toError(cause);
          failures.push({ provider: provider.name, error });
          const next = providers[index + 1];
          const onFallback = context.metadata.get("pipeline.onFallback");
          if (next && typeof onFallback === "function") {
            (onFallback as NonNullable<PipelineOptions["onFallback"]>)({
              stage: name,
              from: provider.name,
              to: next.name,
              error,
            });
          }
        }
      }
      throw new PipelineProviderError(name, failures);
    },
    async close() {
      await Promise.allSettled(providers.map((provider) => provider.close?.()));
    },
  };
}

export function runPipeline<T>(
  source: AsyncIterable<T> | Iterable<T>,
  stages: readonly PipelineStage<unknown, unknown>[],
  options: PipelineOptions = {},
): AsyncIterable<unknown> {
  const highWaterMark = options.highWaterMark ?? 1;
  if (!Number.isInteger(highWaterMark) || highWaterMark < 1) throw new RangeError("highWaterMark must be a positive integer");
  let stream: AsyncIterable<unknown> = toAsync(source);
  for (const stage of stages) stream = executeStage(stream, stage, options, highWaterMark);
  return closeStages(stream, stages);
}

async function* executeStage(
  source: AsyncIterable<unknown>,
  stage: PipelineStage<unknown, unknown>,
  options: PipelineOptions,
  highWaterMark: number,
): AsyncIterable<unknown> {
  const queue = new BoundedAsyncQueue<unknown>(highWaterMark);
  const metadata = new Map<string, unknown>();
  if (options.onFallback) metadata.set("pipeline.onFallback", options.onFallback);
  const now = options.now ?? (() => performance.now());
  const producer = (async () => {
    try {
      for await (const input of source) {
        throwIfAborted(options.signal);
        const startedAt = now();
        let ok = false;
        let caught: Error | undefined;
        try {
          const output = await stage.process(input, {
            signal: options.signal ?? neverAbortedSignal,
            stage: stage.name,
            attempt: 1,
            metadata,
          });
          if (isAsyncIterable(output)) {
            for await (const item of output) {
              throwIfAborted(options.signal);
              await queue.push(item, options.signal);
            }
          } else {
            await queue.push(output, options.signal);
          }
          ok = true;
        } catch (error) {
          caught = toError(error);
          throw caught;
        } finally {
          const endedAt = now();
          const timing: PipelineTiming = {
            stage: stage.name,
            provider: stage.name,
            attempt: 1,
            startedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - startedAt),
            ok,
          };
          if (caught) timing.error = caught;
          options.onTiming?.(timing);
        }
      }
      queue.end();
    } catch (error) {
      queue.fail(error);
    }
  })();
  try {
    for await (const output of queue) yield output;
    await producer;
  } finally {
    queue.end();
  }
}

async function* closeStages(source: AsyncIterable<unknown>, stages: readonly PipelineStage<unknown, unknown>[]) {
  try {
    yield* source;
  } finally {
    await Promise.allSettled([...stages].reverse().map((stage) => stage.close?.()));
  }
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }[] = [];
  private readonly writers: (() => void)[] = [];
  private done = false;
  private failure: unknown;
  private readonly capacity: number;

  constructor(capacity: number) { this.capacity = capacity; }

  async push(value: T, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    while (!this.done && this.values.length >= this.capacity && this.readers.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        this.writers.push(() => { cleanup(); resolve(); });
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (this.done) throw this.failure ?? new Error("Queue is closed");
    const reader = this.readers.shift();
    if (reader) reader.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.readers.length) this.readers.shift()!.resolve({ value: undefined, done: true });
    while (this.writers.length) this.writers.shift()!();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.done = true;
    while (this.readers.length) this.readers.shift()!.reject(error);
    while (this.writers.length) this.writers.shift()!();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length) {
          const value = this.values.shift()!;
          this.writers.shift()?.();
          return { value, done: false };
        }
        if (this.done) {
          if (this.failure) throw this.failure;
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.readers.push({ resolve, reject }));
      },
      return: async () => { this.end(); return { value: undefined, done: true }; },
    };
  }
}

export interface STTProvider<Audio, Transcript> {
  name: string;
  transcribe(audio: Audio, context: StageContext): Awaitable<Transcript | AsyncIterable<Transcript>>;
  close?(): Awaitable<void>;
  raw?: unknown;
}

export interface LLMProvider<Transcript, Completion> {
  name: string;
  generate(transcript: Transcript, context: StageContext): Awaitable<Completion | AsyncIterable<Completion>>;
  close?(): Awaitable<void>;
  raw?: unknown;
}

export interface TTSProvider<Completion, Audio> {
  name: string;
  synthesize(completion: Completion, context: StageContext): Awaitable<Audio | AsyncIterable<Audio>>;
  close?(): Awaitable<void>;
  raw?: unknown;
}

export function createVoicePipeline<AudioIn, Transcript, Completion, AudioOut>(config: {
  stt: STTProvider<AudioIn, Transcript> | readonly STTProvider<AudioIn, Transcript>[];
  llm: LLMProvider<Transcript, Completion> | readonly LLMProvider<Transcript, Completion>[];
  tts: TTSProvider<Completion, AudioOut> | readonly TTSProvider<Completion, AudioOut>[];
  options?: PipelineOptions;
}) {
  const stt = fallbackStage("stt", asArray(config.stt).map((provider) => adapt(provider, (value, context) => provider.transcribe(value as AudioIn, context))));
  const llm = fallbackStage("llm", asArray(config.llm).map((provider) => adapt(provider, (value, context) => provider.generate(value as Transcript, context))));
  const tts = fallbackStage("tts", asArray(config.tts).map((provider) => adapt(provider, (value, context) => provider.synthesize(value as Completion, context))));
  return {
    capabilities: { backpressure: true, abort: true, stageTiming: true, fallback: true } as const,
    raw: { stt: stt.raw, llm: llm.raw, tts: tts.raw },
    run(source: AsyncIterable<AudioIn> | Iterable<AudioIn>, options: PipelineOptions = {}): AsyncIterable<AudioOut> {
      return runPipeline(source, [stt, llm, tts], { ...config.options, ...options }) as AsyncIterable<AudioOut>;
    },
  };
}

function fallbackStage(name: string, stages: PipelineStage<unknown, unknown>[]): PipelineStage<unknown, unknown> {
  return withFallback(name, stages);
}
function adapt(provider: { name: string; close?(): Awaitable<void>; raw?: unknown }, process: PipelineStage<unknown, unknown>["process"]): PipelineStage<unknown, unknown> {
  const stage: PipelineStage<unknown, unknown> = { name: provider.name, process, raw: provider.raw ?? provider };
  if (provider.close) stage.close = provider.close.bind(provider);
  return stage;
}
function asArray<T>(value: T | readonly T[]): readonly T[] { return Array.isArray(value) ? value : [value as T]; }
function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> { return !!value && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"; }
async function* toAsync<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> { yield* source; }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
const neverAbortedSignal = new AbortController().signal;
