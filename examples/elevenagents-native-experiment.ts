import {
  createElevenAgentsRouteDescriptor,
  defineElevenAgentsExperiment,
  readElevenAgentsAttribution,
} from "@jchaffin/voicekit-provider-elevenlabs";

export const nativeExperiment = defineElevenAgentsExperiment({
  id: "exp-native-voice",
  agentId: "agent-support",
  variants: [
    { branchId: "branch-control", versionId: "version-10", percentage: 50 },
    { branchId: "branch-treatment", versionId: "version-11", percentage: 50 },
  ],
});

// No branch/version is sent: ElevenAgents owns assignment.
export const route = createElevenAgentsRouteDescriptor({
  kind: "webrtc-token",
  method: "POST",
  agentId: nativeExperiment.agentId,
  routing: {
    mode: "provider-assigned",
    agentId: nativeExperiment.agentId,
    experimentId: nativeExperiment.id,
  },
});

export function captureNativeAttribution(providerResponse: unknown) {
  return readElevenAgentsAttribution(providerResponse, "provider-assigned");
}
