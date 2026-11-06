# Provider capability guide

Capabilities are runtime facts, not marketing categories. Read each adapter's exported capability object and negotiate required behavior before creating a call.

OpenAI is the complete native S2S path: realtime input and output, transcription, model generation, speech synthesis, interruption, and tool calls are available in one session. Its separate LLM adapter supports streaming text and tools for cascaded pipelines.

GPT-Live is a separate alpha.1 adapter with full-duplex listen/speak state and Responses or application-owned delegation. It exposes WebRTC, WebSocket, SIP, and sideband descriptors but leaves network construction to the injected client. Interruption can continue or cancel client-delegated work according to policy.

ElevenLabs provides a complete conversational realtime path with transcripts, audio, tools, and interruption. Its separate TTS adapter streams audio but cannot retract already emitted chunks; applications must stop playback locally when interrupted.

Deepgram provides streaming STT with interim results, endpointing, confidence, and word data, plus a separate streaming TTS adapter. It is not a model runtime, does not execute tools, and its TTS stream does not declare provider-side interruption.

AssemblyAI is an STT component for a cascaded pipeline. It should be paired with a model provider and TTS provider; it is not a native S2S runtime.

Cartesia provides streaming TTS with word timestamps and an interruptible synthesis context. It does not provide STT, model inference, or tools.

LiveKit transport carries audio and reliable data and supports reconnect, but transport capability must not be confused with agent capability: the transport itself does not perform interruption or tools. The LiveKit runtime adds hosted-agent audio, interruption, and tools over that transport.

ElevenAgents routing supports two mutually exclusive ownership modes. Provider-assigned mode omits branch/version and reads returned attribution. VoiceKit-explicit mode pins branch/version. LiveKit alpha.1 dispatch similarly distinguishes agent name from named deployment and environment.

Pipecat is a hosted cascaded runtime contract. Its manifest declares transport, interruption, tool, and metrics support, while its control client handles configuration, input, interruption, tool results, acknowledgement, and normalized events.

## Selection rules

Choose native S2S when a single-provider voice model meets policy, language, tool, data-residency, and observability requirements. Choose a cascaded pipeline when components need independent selection, fallback, or instrumentation. Choose a hosted runtime when server-side media processing and durable operation matter more than direct browser-to-provider connectivity.

Treat undeclared capability as unavailable. Require conformance results for connect/close, auth, ordering, interruption, dedupe, resume, cancellation, usage, raw events, backpressure, and timeout before enabling a capability in production.

Also require the applicable alpha.1 semantic suite. Offline results validate VoiceKit contracts only; provider endpoints, account features, quotas, and SDK compatibility still require credentialed tests against the official service.
