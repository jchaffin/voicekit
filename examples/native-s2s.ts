import {
  createElevenLabsRealtimeProvider,
  type ElevenLabsConversationFactory,
} from "@jchaffin/voicekit-provider-elevenlabs";

export async function startNativeSpeechToSpeech(input: {
  agentId: string;
  token(signal?: AbortSignal): string | Promise<string>;
  clientFactory: ElevenLabsConversationFactory;
  onText(text: string, role: "user" | "assistant"): void;
  onAudio(audio: Uint8Array): void;
  signal?: AbortSignal;
}) {
  const provider = createElevenLabsRealtimeProvider({
    token: input.token,
    clientFactory: input.clientFactory,
    providerOptions: { agentId: input.agentId, language: "en" },
  });
  const session = await provider.connect(
    input.signal === undefined ? {} : { signal: input.signal },
  );
  const off = session.onEvent((event) => {
    if (event.type === "transcript" && event.isFinal) input.onText(event.text, event.role);
    if (event.type === "audio") input.onAudio(event.audio);
  });
  return {
    sendAudio: (frame: Uint8Array) => session.sendAudio(frame),
    interrupt: () => session.interrupt(),
    submitToolResult: (callId: string, result: unknown) => session.sendToolResult(callId, result),
    async close() {
      off();
      await session.close();
    },
  };
}
