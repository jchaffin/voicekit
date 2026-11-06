# @jchaffin/voicekit-react

Headless React bindings for VoiceKit voice sessions, experiments, and GPT-Live delegation.

## Experiments

```tsx
const experiment = createExperimentStore({
  id: 'gpt-live',
  name: 'GPT-Live rollout',
  variants: [
    { id: 'control', name: 'Control', weight: 90 },
    { id: 'live', name: 'GPT-Live', weight: 10 },
  ],
});

<ExperimentProvider store={experiment}>
  <ExperimentControls />
</ExperimentProvider>
```

`useExperiment()` exposes the definition, status, assignments, exposures, outcomes, guardrails, and the
`rollout`, `pause`, `promote`, `rollback`, and `updateVariants` actions. Supply an `ExperimentAdapter` to
persist actions and observations. Variant updates are rejected unless weights total 100.

## GPT-Live delegation

```tsx
const delegation = createDelegationStore({ transport });

<DelegationProvider store={delegation}>
  <Conversation />
</DelegationProvider>
```

`useDelegation()` tracks conversation and backend-task lifecycles. Listening and speaking are independent
booleans so full-duplex activity is represented correctly. Tasks and the whole conversation can be cancelled.
Selector hooks are available for render-efficient subscriptions.
