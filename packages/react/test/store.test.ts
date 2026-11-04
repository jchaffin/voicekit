import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '@jchaffin/voicekit-protocol';
import { createVoiceSessionStore, type VoiceSessionTransport } from '../src/store.js';

function transport() {
  let listener: ((event: EventEnvelope) => void) | undefined;
  const calls: string[] = [];
  const value: VoiceSessionTransport = {
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    connect: () => { calls.push('connect'); },
    disconnect: () => { calls.push('disconnect'); },
    setMuted: muted => { calls.push(`mute:${muted}`); },
    interrupt: () => { calls.push('interrupt'); },
    sendText: text => { calls.push(`text:${text}`); },
    resolveToolApproval: (id, approved) => { calls.push(`approval:${id}:${approved}`); },
  };
  return { value, calls, emit: (event: EventEnvelope) => listener?.(event) };
}

function envelope(event: EventEnvelope['event'], sequence = 1): EventEnvelope {
  return {
    protocolVersion: '1.0',
    id: `event-${sequence}`,
    sessionId: 'session-1',
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    event,
  };
}

test('reduces canonical lifecycle and transcript events', async () => {
  const mock = transport();
  const store = createVoiceSessionStore(mock.value);
  await store.getSnapshot().connect();
  mock.emit(envelope({ type: 'lifecycle.phase_changed', data: { from: 'connecting', to: 'listening' } }));
  mock.emit(envelope({ type: 'turn.started', data: { turnId: 'turn-1', participant: 'user' } }, 2));
  mock.emit(envelope({ type: 'transcript.final', data: { turnId: 'turn-1', text: 'Hello' } }, 3));

  assert.equal(store.getSnapshot().status, 'connected');
  assert.equal(store.getSnapshot().listening, true);
  assert.deepEqual(store.getSnapshot().transcript[0], {
    id: 'event-3:turn-1',
    turnId: 'turn-1',
    role: 'user',
    text: 'Hello',
    isFinal: true,
    timestamp: '2026-01-01T00:00:00.000Z',
  });
});

test('actions delegate and approvals update without React rendering', async () => {
  const mock = transport();
  const store = createVoiceSessionStore(mock.value);
  await store.getSnapshot().connect();
  mock.emit(envelope({ type: 'tool.call_started', data: { callId: 'call-1', name: 'search', arguments: { q: 'voice' } } }));
  await store.getSnapshot().approve('call-1');
  await store.getSnapshot().mute(true);
  await store.getSnapshot().sendText('  hello  ');

  assert.equal(store.getSnapshot().approvals[0]?.status, 'approved');
  assert.deepEqual(mock.calls, ['connect', 'approval:call-1:true', 'mute:true', 'text:hello']);
});
