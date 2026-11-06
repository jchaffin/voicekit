import { ExperimentProvider, type ExperimentDefinition } from "@jchaffin/voicekit-react";
import {
  AssignmentDetail,
  ExperimentLifecycleControls,
  ExperimentOverview,
  ExperimentStatusRegion,
  ExposureFunnel,
  VariantTrafficEditor,
} from "@jchaffin/voicekit-ui";

const definition: ExperimentDefinition = {
  id: "provider-routing",
  name: "Provider routing",
  hypothesis: "A hosted route improves resolution without breaching latency guardrails.",
  variants: [
    { id: "gpt-live", name: "GPT-Live", weight: 50, provider: "openai" },
    { id: "hosted", name: "Hosted", weight: 50, provider: "livekit" },
  ],
};

export function AccessibleExperimentConsole() {
  return (
    <ExperimentProvider definition={definition}>
      <main aria-labelledby="experiment-title">
        <h1 id="experiment-title">Voice experiment</h1>
        <ExperimentStatusRegion />
        <ExperimentOverview />
        <ExposureFunnel />
        <VariantTrafficEditor />
        <ExperimentLifecycleControls />
        <AssignmentDetail assignment={{
          subjectId: "user-42",
          variantId: "gpt-live",
          assignedAt: "2026-11-05T00:00:00.000Z",
        }} />
      </main>
    </ExperimentProvider>
  );
}
