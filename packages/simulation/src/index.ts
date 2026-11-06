import {
  VOICEKIT_PROTOCOL_VERSION,
  type EventEnvelope,
  type JsonValue,
  type VoiceKitEvent,
} from "@jchaffin/voicekit-protocol";

export interface ScheduledTask {
  readonly id: number;
  readonly dueAt: number;
  cancel(): void;
}

interface PendingTask {
  id: number;
  dueAt: number;
  order: number;
  callback: () => void;
  cancelled: boolean;
}

/** A manually advanced, monotonic clock. No wall-clock timers are used. */
export class VirtualClock {
  #now: number;
  #nextId = 1;
  #order = 0;
  readonly #tasks: PendingTask[] = [];

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs) || startMs < 0) throw new RangeError("startMs must be finite and non-negative");
    this.#now = startMs;
  }

  now(): number { return this.#now; }
  date(): Date { return new Date(this.#now); }
  get pending(): number { return this.#tasks.filter((task) => !task.cancelled).length; }

  schedule(delayMs: number, callback: () => void): ScheduledTask {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs must be finite and non-negative");
    const task: PendingTask = {
      id: this.#nextId++,
      dueAt: this.#now + delayMs,
      order: this.#order++,
      callback,
      cancelled: false,
    };
    this.#tasks.push(task);
    return { id: task.id, dueAt: task.dueAt, cancel: () => { task.cancelled = true; } };
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const task = this.schedule(delayMs, () => {
        cleanup();
        resolve();
      });
      const abort = () => {
        task.cancel();
        cleanup();
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  advanceBy(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("durationMs must be finite and non-negative");
    this.advanceTo(this.#now + durationMs);
  }

  advanceTo(targetMs: number): void {
    if (!Number.isFinite(targetMs) || targetMs < this.#now) throw new RangeError("VirtualClock cannot move backwards");
    for (;;) {
      const task = this.#nextTask(targetMs);
      if (!task) break;
      this.#now = task.dueAt;
      task.cancelled = true;
      task.callback();
    }
    this.#now = targetMs;
  }

  runAll(maxTasks = 10_000): void {
    let count = 0;
    while (this.pending > 0) {
      if (++count > maxTasks) throw new Error(`VirtualClock exceeded ${maxTasks} tasks`);
      const next = this.#nextTask(Number.POSITIVE_INFINITY);
      if (!next) break;
      this.#now = next.dueAt;
      next.cancelled = true;
      next.callback();
    }
  }

  #nextTask(targetMs: number): PendingTask | undefined {
    return this.#tasks
      .filter((task) => !task.cancelled && task.dueAt <= targetMs)
      .sort((left, right) => left.dueAt - right.dueAt || left.order - right.order)[0];
  }
}

export interface AudioFixture {
  readonly id: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameDurationMs: number;
  readonly frames: readonly Uint8Array[];
  readonly durationMs: number;
}

export function syntheticAudio(options: {
  id?: string;
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  frameDurationMs?: number;
  frequencyHz?: number;
  amplitude?: number;
}): AudioFixture {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const frameDurationMs = options.frameDurationMs ?? 20;
  const frequencyHz = options.frequencyHz ?? 440;
  const amplitude = options.amplitude ?? 0.25;
  if (options.durationMs < 0 || frameDurationMs <= 0 || sampleRate <= 0 || channels <= 0) {
    throw new RangeError("Audio dimensions must be positive");
  }
  const frameCount = Math.ceil(options.durationMs / frameDurationMs);
  const samplesPerFrame = Math.round(sampleRate * frameDurationMs / 1000);
  const frames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const bytes = new Uint8Array(samplesPerFrame * channels * 2);
    const view = new DataView(bytes.buffer);
    for (let sample = 0; sample < samplesPerFrame; sample += 1) {
      const absolute = frameIndex * samplesPerFrame + sample;
      const value = Math.round(Math.sin(2 * Math.PI * frequencyHz * absolute / sampleRate) * amplitude * 0x7fff);
      for (let channel = 0; channel < channels; channel += 1) {
        view.setInt16((sample * channels + channel) * 2, value, true);
      }
    }
    return bytes;
  });
  return Object.freeze({
    id: options.id ?? `tone-${frequencyHz}hz-${options.durationMs}ms`,
    sampleRate,
    channels,
    frameDurationMs,
    frames: Object.freeze(frames),
    durationMs: frameCount * frameDurationMs,
  });
}

export const silence = (durationMs: number, options: Omit<Parameters<typeof syntheticAudio>[0], "durationMs" | "amplitude"> = {}) =>
  syntheticAudio({ ...options, durationMs, amplitude: 0 });

export type CallerAction =
  | { atMs: number; type: "say"; text: string; audio?: AudioFixture }
  | { atMs: number; type: "audio"; audio: AudioFixture }
  | { atMs: number; type: "interrupt"; reason?: string }
  | { atMs: number; type: "disconnect"; reason?: string }
  | { atMs: number; type: "reconnect" }
  | { atMs: number; type: "custom"; name: string; data?: JsonValue };

export interface ScriptedCallerSink {
  onAction(action: CallerAction): void | Promise<void>;
}

export class ScriptedCaller {
  readonly actions: readonly CallerAction[];

  constructor(actions: readonly CallerAction[]) {
    let previous = -1;
    for (const action of actions) {
      if (action.atMs < previous) throw new RangeError("Caller actions must be ordered by atMs");
      previous = action.atMs;
    }
    this.actions = Object.freeze([...actions]);
  }

  run(clock: VirtualClock, sink: ScriptedCallerSink): readonly ScheduledTask[] {
    const startedAt = clock.now();
    return this.actions.map((action) =>
      clock.schedule(action.atMs, () => { void sink.onAction(action); }),
    ).map((task) => ({ ...task, dueAt: startedAt + task.dueAt - startedAt }));
  }
}

export interface TranscriptChunk {
  readonly text: string;
  readonly final: boolean;
  readonly delayMs: number;
  readonly confidence?: number;
}

export class FakeTranscriptProvider {
  readonly #scripts: ReadonlyMap<string, readonly TranscriptChunk[]>;
  readonly calls: string[] = [];

  constructor(scripts: Readonly<Record<string, readonly TranscriptChunk[]>>) {
    this.#scripts = new Map(Object.entries(scripts));
  }

  async *transcribe(fixture: AudioFixture, clock: VirtualClock, signal?: AbortSignal): AsyncIterable<TranscriptChunk> {
    this.calls.push(fixture.id);
    for (const chunk of this.#scripts.get(fixture.id) ?? []) {
      await clock.sleep(chunk.delayMs, signal);
      yield chunk;
    }
  }
}

export interface ModelChunk {
  readonly type: "text" | "tool";
  readonly delayMs: number;
  readonly text?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly input?: JsonValue;
}

export class FakeModelProvider {
  readonly #scripts: ReadonlyMap<string, readonly ModelChunk[]>;
  readonly calls: string[] = [];

  constructor(scripts: Readonly<Record<string, readonly ModelChunk[]>>) {
    this.#scripts = new Map(Object.entries(scripts));
  }

  async *generate(prompt: string, clock: VirtualClock, signal?: AbortSignal): AsyncIterable<ModelChunk> {
    this.calls.push(prompt);
    for (const chunk of this.#scripts.get(prompt) ?? []) {
      await clock.sleep(chunk.delayMs, signal);
      yield chunk;
    }
  }
}

export interface SynthesizedAudio {
  readonly text: string;
  readonly fixture: AudioFixture;
  readonly delayMs: number;
}

export class FakeTTSProvider {
  readonly calls: string[] = [];
  readonly #delayMs: number;
  readonly #millisecondsPerCharacter: number;

  constructor(options: { delayMs?: number; millisecondsPerCharacter?: number } = {}) {
    this.#delayMs = options.delayMs ?? 30;
    this.#millisecondsPerCharacter = options.millisecondsPerCharacter ?? 12;
  }

  async synthesize(text: string, clock: VirtualClock, signal?: AbortSignal): Promise<SynthesizedAudio> {
    this.calls.push(text);
    await clock.sleep(this.#delayMs, signal);
    return {
      text,
      delayMs: this.#delayMs,
      fixture: syntheticAudio({
        id: `tts-${this.calls.length}`,
        durationMs: Math.max(20, text.length * this.#millisecondsPerCharacter),
        frequencyHz: 220,
      }),
    };
  }
}

export interface NetworkFaults {
  latencyMs?: number;
  jitterMs?: number;
  lossEvery?: number;
  disconnectAtMs?: number;
  reconnectAtMs?: number;
}

/** Deterministic network fault injector; jitter alternates +/− around latency. */
export class FaultyNetwork<T> {
  readonly #clock: VirtualClock;
  readonly #faults: NetworkFaults;
  #sent = 0;

  constructor(clock: VirtualClock, faults: NetworkFaults = {}) {
    this.#clock = clock;
    this.#faults = faults;
  }

  send(value: T, deliver: (value: T) => void): "scheduled" | "lost" | "disconnected" {
    this.#sent += 1;
    const now = this.#clock.now();
    if (
      this.#faults.disconnectAtMs !== undefined
      && now >= this.#faults.disconnectAtMs
      && (this.#faults.reconnectAtMs === undefined || now < this.#faults.reconnectAtMs)
    ) return "disconnected";
    if (this.#faults.lossEvery && this.#sent % this.#faults.lossEvery === 0) return "lost";
    const direction = this.#sent % 2 === 0 ? -1 : 1;
    const delay = Math.max(0, (this.#faults.latencyMs ?? 0) + direction * (this.#faults.jitterMs ?? 0));
    this.#clock.schedule(delay, () => deliver(value));
    return "scheduled";
  }
}

export interface ToolFault {
  delayMs?: number;
  fail?: Error | string;
}

export class FakeTool<I = JsonValue, O = JsonValue> {
  readonly name: string;
  readonly calls: { callId: string; input: I }[] = [];
  readonly #execute: (input: I) => O | Promise<O>;
  readonly #faults: readonly ToolFault[];

  constructor(name: string, execute: (input: I) => O | Promise<O>, faults: readonly ToolFault[] = []) {
    this.name = name;
    this.#execute = execute;
    this.#faults = faults;
  }

  async call(callId: string, input: I, clock: VirtualClock, signal?: AbortSignal): Promise<O> {
    const index = this.calls.length;
    this.calls.push({ callId, input });
    const fault = this.#faults[index];
    if (fault?.delayMs) await clock.sleep(fault.delayMs, signal);
    if (fault?.fail) throw fault.fail instanceof Error ? fault.fail : new Error(fault.fail);
    return this.#execute(input);
  }
}

export interface JournalSnapshot {
  readonly name: string;
  readonly capturedAtMs: number;
  readonly events: readonly EventEnvelope[];
}

export class SimulationJournal {
  readonly #clock: VirtualClock;
  readonly #sessionId: string;
  readonly #events: EventEnvelope[] = [];
  #id = 0;

  constructor(clock: VirtualClock, sessionId = "simulation") {
    this.#clock = clock;
    this.#sessionId = sessionId;
  }

  append(event: VoiceKitEvent): EventEnvelope {
    const envelope: EventEnvelope = {
      protocolVersion: VOICEKIT_PROTOCOL_VERSION,
      id: `sim-${++this.#id}`,
      sessionId: this.#sessionId,
      sequence: this.#events.length + 1,
      timestamp: this.#clock.date().toISOString(),
      event,
    };
    this.#events.push(envelope);
    return envelope;
  }

  read(): readonly EventEnvelope[] { return [...this.#events]; }

  snapshot(name = `sequence-${this.#events.length}`): JournalSnapshot {
    return Object.freeze({
      name,
      capturedAtMs: this.#clock.now(),
      events: Object.freeze(structuredClone(this.#events)),
    });
  }

  restore(snapshot: JournalSnapshot): void {
    this.#events.splice(0, this.#events.length, ...structuredClone(snapshot.events));
    this.#id = this.#events.length;
  }
}

export type TimelineScenario =
  | { type: "interruption"; userAtMs: number; agentStartedAtMs: number; expectedStopWithinMs: number }
  | { type: "overlap"; firstStartedAtMs: number; secondStartedAtMs: number; durationMs: number };

export const interruptionScenario = (
  userAtMs: number,
  options: { agentStartedAtMs?: number; expectedStopWithinMs?: number } = {},
): TimelineScenario => ({
  type: "interruption",
  userAtMs,
  agentStartedAtMs: options.agentStartedAtMs ?? 0,
  expectedStopWithinMs: options.expectedStopWithinMs ?? 100,
});

export const overlapScenario = (
  firstStartedAtMs: number,
  secondStartedAtMs: number,
  durationMs: number,
): TimelineScenario => ({ type: "overlap", firstStartedAtMs, secondStartedAtMs, durationMs });

export class SimulationAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationAssertionError";
  }
}

export type Assertion = (events: readonly EventEnvelope[]) => void;

function eventsOf(events: readonly EventEnvelope[], type: VoiceKitEvent["type"]) {
  return events.filter((envelope) => envelope.event.type === type);
}

export function handoffOccurred(target?: string): Assertion {
  return (events) => {
    const matches = eventsOf(events, "handoff.completed");
    if (!matches.some((entry) => !target || (entry.event.type === "handoff.completed" && entry.event.data.target === target))) {
      throw new SimulationAssertionError(`Expected completed handoff${target ? ` to "${target}"` : ""}`);
    }
  };
}

export function toolCalledOnce(name: string): Assertion {
  return (events) => {
    const count = eventsOf(events, "tool.call_started")
      .filter((entry) => entry.event.type === "tool.call_started" && entry.event.data.name === name).length;
    if (count !== 1) throw new SimulationAssertionError(`Expected tool "${name}" once, received ${count} calls`);
  };
}

export function noPolicyViolations(): Assertion {
  return (events) => {
    const violations = eventsOf(events, "policy.violation");
    if (violations.length) throw new SimulationAssertionError(`Expected no policy violations, received ${violations.length}`);
  };
}

export function firstAudioUnder(milliseconds: number, from: "session" | "user-turn" = "user-turn"): Assertion {
  return (events) => {
    const origin = from === "session"
      ? events[0]
      : events.find((entry) => entry.event.type === "turn.started" && entry.event.data.participant === "user");
    const audio = events.find((entry) =>
      entry.event.type === "media.frame"
      && entry.event.data.streamId.startsWith("output"),
    );
    if (!origin || !audio) throw new SimulationAssertionError("Cannot measure first audio without origin and output frame events");
    const latency = Date.parse(audio.timestamp) - Date.parse(origin.timestamp);
    if (latency >= milliseconds) {
      throw new SimulationAssertionError(`Expected first audio under ${milliseconds}ms, received ${latency}ms`);
    }
  };
}

export function assertSimulation(events: readonly EventEnvelope[], ...assertions: readonly Assertion[]): void {
  for (const assertion of assertions) assertion(events);
}

export type DuplexChannel = "listening" | "speaking";
export interface DuplexTransition {
  readonly atMs: number;
  readonly channel: DuplexChannel;
  readonly active: boolean;
  readonly turnId: string;
}

/** Deterministic full-duplex state model; listening and speaking are independent channels. */
export class FullDuplexSimulation {
  readonly #clock: VirtualClock;
  readonly #transitions: DuplexTransition[] = [];
  readonly #active = new Map<DuplexChannel, string>();

  constructor(clock: VirtualClock) { this.#clock = clock; }
  set(channel: DuplexChannel, active: boolean, turnId: string): void {
    if (active) this.#active.set(channel, turnId);
    else if (this.#active.get(channel) === turnId) this.#active.delete(channel);
    this.#transitions.push(Object.freeze({ atMs: this.#clock.now(), channel, active, turnId }));
  }
  get overlapping(): boolean { return this.#active.has("listening") && this.#active.has("speaking"); }
  transitions(): readonly DuplexTransition[] { return [...this.#transitions]; }
}

export type DelegatedTaskState = "running" | "completed" | "cancelled";
export interface DelegatedTaskSnapshot {
  readonly id: string;
  readonly state: DelegatedTaskState;
  readonly cancellationReason?: string;
  readonly terminalAtMs?: number;
}

/** Models application-owned delegated work separately from voice playback. */
export class DelegatedTaskSimulation {
  readonly #clock: VirtualClock;
  readonly #tasks = new Map<string, DelegatedTaskSnapshot>();
  constructor(clock: VirtualClock) { this.#clock = clock; }
  start(id: string): DelegatedTaskSnapshot {
    const existing = this.#tasks.get(id);
    if (existing) return existing;
    const task = Object.freeze({ id, state: "running" as const });
    this.#tasks.set(id, task);
    return task;
  }
  interrupt(id: string, policy: "continue" | "cancel"): DelegatedTaskSnapshot | undefined {
    return policy === "cancel" ? this.cancel(id, "voice_interrupted") : this.#tasks.get(id);
  }
  cancel(id: string, cancellationReason = "application_cancelled"): DelegatedTaskSnapshot | undefined {
    const current = this.#tasks.get(id);
    if (!current || current.state !== "running") return current;
    const next = Object.freeze({ id, state: "cancelled" as const, cancellationReason, terminalAtMs: this.#clock.now() });
    this.#tasks.set(id, next);
    return next;
  }
  complete(id: string): DelegatedTaskSnapshot | undefined {
    const current = this.#tasks.get(id);
    if (!current || current.state !== "running") return current;
    const next = Object.freeze({ id, state: "completed" as const, terminalAtMs: this.#clock.now() });
    this.#tasks.set(id, next);
    return next;
  }
  get(id: string): DelegatedTaskSnapshot | undefined { return this.#tasks.get(id); }
}

export interface ExperimentFallbackRecord {
  readonly assignmentId: string;
  readonly intendedVariantId: string;
  readonly actualProvider: string;
  readonly exposureId: string;
  readonly fallback: true;
}

/** Exactly-once fallback exposure model that preserves intention-to-treat assignment. */
export class ExperimentFallbackSimulation {
  readonly #records = new Map<string, ExperimentFallbackRecord>();
  record(input: ExperimentFallbackRecord): ExperimentFallbackRecord {
    const existing = this.#records.get(input.exposureId);
    if (existing) return existing;
    const record = Object.freeze({ ...input });
    this.#records.set(input.exposureId, record);
    return record;
  }
  read(): readonly ExperimentFallbackRecord[] { return [...this.#records.values()]; }
}

export interface ReplayOptions {
  fromSequence?: number;
  toSequence?: number;
  speed?: number;
  onEvent(event: EventEnvelope): void | Promise<void>;
}

/** Replays journal timing through a virtual clock and returns the scheduled tasks. */
export function replay(
  snapshot: JournalSnapshot | readonly EventEnvelope[],
  clock: VirtualClock,
  options: ReplayOptions,
): readonly ScheduledTask[] {
  const events = ("events" in snapshot ? snapshot.events : snapshot)
    .filter((event) => event.sequence >= (options.fromSequence ?? 1))
    .filter((event) => event.sequence <= (options.toSequence ?? Number.POSITIVE_INFINITY));
  if (!events.length) return [];
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Replay speed must be positive");
  const startedAt = Date.parse(events[0]!.timestamp);
  return events.map((event) => {
    const delay = Math.max(0, Date.parse(event.timestamp) - startedAt) / speed;
    return clock.schedule(delay, () => { void options.onEvent(structuredClone(event)); });
  });
}
