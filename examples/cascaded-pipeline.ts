import {
  createVoicePipeline,
  type LLMProvider,
  type STTProvider,
  type TTSProvider,
} from "@jchaffin/voicekit-pipeline";

export interface Transcript {
  text: string;
  final: boolean;
}

export interface Completion {
  text: string;
}

export function createCascadedVoicePipeline(input: {
  stt: STTProvider<Uint8Array, Transcript>;
  fallbackStt?: STTProvider<Uint8Array, Transcript>;
  llm: LLMProvider<Transcript, Completion>;
  tts: TTSProvider<Completion, Uint8Array>;
  onStageTiming?: (stage: string, durationMs: number) => void;
}) {
  return createVoicePipeline({
    stt: input.fallbackStt ? [input.stt, input.fallbackStt] : input.stt,
    llm: input.llm,
    tts: input.tts,
    options: {
      highWaterMark: 4,
      onTiming: ({ stage, durationMs }) => input.onStageTiming?.(stage, durationMs),
      onFallback: ({ stage, from, to, error }) => {
        console.warn(`${stage} fell back from ${from} to ${to}: ${error.message}`);
      },
    },
  });
}

export async function collectResponseAudio(
  pipeline: ReturnType<typeof createCascadedVoicePipeline>,
  microphoneFrames: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pipeline.run(
    microphoneFrames,
    signal === undefined ? {} : { signal },
  )) chunks.push(chunk);
  return chunks;
}
