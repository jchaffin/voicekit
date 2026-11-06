import {
  createLiveKitDispatchDescriptor,
  defineLiveKitDispatch,
} from "@jchaffin/voicekit-transport-livekit";

const deployment = defineLiveKitDispatch({
  agentName: "support",
  deploymentName: "support-alpha-1",
  environment: "production",
  experimentAssignmentId: "assignment-42",
  metadata: { tenant: "acme", variant: "hosted" },
});

// Convert this descriptor to the corresponding LiveKit server-SDK dispatch request.
export const dispatch = createLiveKitDispatchDescriptor({
  kind: "api-dispatch",
  dispatch: deployment,
  roomName: "support-call-42",
  participantIdentity: "customer-42",
});
