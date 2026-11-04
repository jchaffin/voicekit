# @jchaffin/voicekit-simulation

Deterministic VoiceKit test infrastructure for running complete voice scenarios without microphones, networks, provider accounts, or wall-clock sleeps.

```ts
import {
  SimulationJournal,
  VirtualClock,
  assertSimulation,
  firstAudioUnder,
  noPolicyViolations,
} from "@jchaffin/voicekit-simulation";

const clock = new VirtualClock();
const journal = new SimulationJournal(clock, "checkout-call");
// Drive the application and append its normalized protocol events.
clock.runAll();
assertSimulation(journal.read(), firstAudioUnder(300), noPolicyViolations());
```

The package includes synthetic PCM fixtures, scripted callers, fake transcript/model/TTS providers, deterministic network and tool faults, interruption/overlap scenarios, immutable journal snapshots, assertions, and timing-preserving replay.
