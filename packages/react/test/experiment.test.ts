import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperimentStore, getExperimentAssignmentDeviation } from '../src/experiment.js';

const definition = {
  id: 'exp-1',
  name: 'GPT-Live routing',
  variants: [
    { id: 'control', name: 'Control', weight: 50 },
    { id: 'live', name: 'GPT-Live', weight: 50 },
  ],
} as const;

test('validates traffic and runs lifecycle adapters', async () => {
  const calls: string[] = [];
  const store = createExperimentStore(definition, {
    adapter: {
      rollout: () => { calls.push('rollout'); },
      promote: (_id, variantId) => { calls.push(`promote:${variantId}`); },
    },
  });

  await store.getSnapshot().rollout();
  await store.getSnapshot().promote('live');

  assert.equal(store.getSnapshot().status, 'promoted');
  assert.equal(store.getSnapshot().promotedVariantId, 'live');
  assert.deepEqual(calls, ['rollout', 'promote:live']);
  await assert.rejects(
    store.getSnapshot().updateVariants([{ id: 'control', name: 'Control', weight: 20 }]),
    /total 100/,
  );
});

test('records assignment, exposure, outcomes, and deviations', async () => {
  const store = createExperimentStore(definition);
  const assignment = {
    subjectId: 'session-1',
    variantId: 'control',
    expectedVariantId: 'live',
    assignedAt: '2026-01-01T00:00:00.000Z',
  };
  await store.getSnapshot().recordAssignment(assignment);
  await store.getSnapshot().recordExposure({
    id: 'exposure-1',
    subjectId: 'session-1',
    variantId: 'control',
    timestamp: '2026-01-01T00:00:01.000Z',
  });
  await store.getSnapshot().recordOutcome({
    id: 'outcome-1',
    subjectId: 'session-1',
    variantId: 'control',
    metricId: 'latency',
    value: 140,
    timestamp: '2026-01-01T00:00:02.000Z',
  });

  assert.equal(store.getSnapshot().assignments.length, 1);
  assert.equal(store.getSnapshot().exposures.length, 1);
  assert.equal(store.getSnapshot().outcomes.length, 1);
  assert.equal(getExperimentAssignmentDeviation(assignment), true);
});
