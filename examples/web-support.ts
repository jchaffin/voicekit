import {
  createOpenAIRealtimeProvider,
  type OpenAIRealtimeClientFactory,
} from "@jchaffin/voicekit-provider-openai";

export interface WebSupportOptions {
  token(signal?: AbortSignal): string | Promise<string>;
  clientFactory: OpenAIRealtimeClientFactory;
  onTranscript(role: "user" | "assistant", text: string, final: boolean): void;
  onAudio(audio: Uint8Array): void;
}

/** Opens a browser support session while keeping provider credentials behind a token callback. */
export async function startWebSupport(options: WebSupportOptions, signal?: AbortSignal) {
  const provider = createOpenAIRealtimeProvider({
    token: options.token,
    clientFactory: options.clientFactory,
    providerOptions: {
      model: "gpt-realtime",
      voice: "marin",
      instructions: "Resolve the support issue. Confirm before any account-changing action.",
    },
  });
  const session = await provider.connect({
    ...(signal === undefined ? {} : { signal }),
    tools: [{
      name: "lookup_order",
      description: "Look up an order by its public order number",
      parameters: {
        type: "object",
        properties: { orderNumber: { type: "string" } },
        required: ["orderNumber"],
      },
    }],
  });
  const off = session.onEvent((event) => {
    if (event.type === "transcript.delta" || event.type === "transcript.final") {
      options.onTranscript(event.role, event.text, event.type === "transcript.final");
    } else if (event.type === "audio.delta") {
      options.onAudio(event.audio);
    }
  });

  return {
    sendMicrophoneFrame: (audio: Uint8Array) => session.sendAudio(audio),
    sendChatMessage: (text: string) => session.sendText(text),
    interrupt: () => session.interrupt(),
    async close() {
      off();
      await session.close();
    },
  };
}
