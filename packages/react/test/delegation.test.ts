import assert from 'node:assert/strict';
import test from 'node:test';
import { createDelegationStore } from '../src/delegation.js';

test('tracks concurrent listening, speaking, and backend tasks', async () => {
  const store = createDelegationStore();
  store.getSnapshot().startConversation('2026-01-01T00:00:00.000Z');
  store.getSnapshot().setListening(true, '2026-01-01T00:00:01.000Z');
  store.getSnapshot().setSpeaking(true, '2026-01-01T00:00:02.000Z');
  await store.getSnapshot().startTask(
    { id: 'task-1', title: 'Retrieve account', backend: 'crm' },
    '2026-01-01T00:00:03.000Z',
  );

  assert.equal(store.getSnapshot().listening, true);
  assert.equal(store.getSnapshot().speaking, true);
  assert.equal(store.getSnapshot().tasks[0]?.status, 'running');
  assert.equal(store.getSnapshot().timeline.length, 5);
});

test('cancels a task through the transport', async () => {
  const calls: string[] = [];
  const store = createDelegationStore({
    transport: { cancelTask: id => { calls.push(id); } },
  });
  await store.getSnapshot().startTask({ id: 'task-1', title: 'Search' });
  await store.getSnapshot().cancelTask('task-1');

  assert.deepEqual(calls, ['task-1']);
  assert.equal(store.getSnapshot().tasks[0]?.status, 'cancelled');
});
