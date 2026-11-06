# @jchaffin/voicekit-ui

Accessible, themeable React components for VoiceKit. Import `@jchaffin/voicekit-ui/theme.css` for the default
theme, or style the stable `vk-*` classes and `data-state` attributes yourself.

## Experiment UI

Render experiment components inside `ExperimentProvider` from `@jchaffin/voicekit-react`:

```tsx
<ExperimentProvider store={experiment}>
  <ExperimentStatusRegion />
  <ExperimentOverview />
  <VariantTrafficEditor />
  <ExperimentLifecycleControls />
  <ExposureFunnel />
</ExperimentProvider>
```

`VariantTrafficEditor` validates that traffic totals exactly 100. Lifecycle actions use a two-step confirmation
affordance. `MetricCard`, `GuardrailCard`, `AssignmentDetail`, and `ProviderRoutingModeBadge` can be composed
into custom dashboards. Funnels and metrics use semantic HTML and CSS bars; there is no chart dependency.

## GPT-Live delegation UI

Render delegation components inside `DelegationProvider`:

```tsx
<DelegationProvider store={delegation}>
  <DelegationLiveRegion />
  <DelegationTimeline />
  {tasks.map(task => <DelegationTaskCard key={task.id} task={task} />)}
</DelegationProvider>
```

Controls use native buttons, inputs, and selects for keyboard behavior. Status changes are announced through
polite live regions, while failures use assertive alerts.
