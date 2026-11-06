import {
  createOpenAILiveController,
  type OpenAILiveClient,
} from "@jchaffin/voicekit-provider-openai-live";

// Supply this boundary with the official SDK or your WebRTC/WebSocket/SIP implementation.
declare const liveClient: OpenAILiveClient;

const controller = createOpenAILiveController({
  client: liveClient,
  options: {
    backend: {
      type: "responses",
      model: "your-responses-model",
      instructions: "Perform account work and return concise commentary.",
      tools: [{ type: "function", name: "lookup_order" }],
    },
    instructions: "Handle the live conversation; delegate account work.",
    cancellation: { onInterruption: "continue", onSessionClose: "cancel" },
  },
});

controller.onEvent((event) => {
  if (event.kind === "openai.live" && event.event.type === "tool.requested") {
    void controller.submitToolResult(event.event.callId, { status: "shipped" });
  }
});

export async function startLiveSession(offerSdp: string) {
  return controller.start({ kind: "webrtc", offerSdp });
}
