# GPT-Live, Realtime, and Eleven Realtime

These integrations have different ownership boundaries; they are not interchangeable model names.

## GPT-Live

`@jchaffin/voicekit-provider-openai-live` models a fixed live voice session with independent listening and speaking channels. It supports Responses delegation, where backend work remains with OpenAI's Responses path, and client delegation, where the application executes a task and streams thinking or commentary back.

Interruption and backend cancellation are separate decisions. The default stops voice playback without cancelling delegated work. Set `onInterruption: "cancel"` only when application-owned tasks are safe to abort. Terminal delegation events and provider event IDs are deduplicated.

## OpenAI Realtime

The existing OpenAI provider is the general Realtime adapter. Use it for the established realtime session/event model. Use GPT-Live only when the application needs the Live endpoint's full-duplex and delegation semantics. Do not send GPT-Live-only session or delegation fields to Realtime.

## Eleven Realtime and ElevenAgents

The ElevenLabs realtime adapter owns a conversational connection with audio, transcripts, interruption, and client tool results. ElevenAgents adds version, branch, deployment, and experiment routing concepts.

For provider-native experiments, send an agent and experiment identity without an explicit branch, then capture returned branch/version attribution. For VoiceKit-managed experiments, send the pinned branch/version and retain the assignment ID. Never let both systems assign the same conversation.

## Verification status

The alpha.1 conformance and simulation suites verify normalization, overlap, interruption, delegation terminal states, routing ownership, and idempotency offline. They do not certify provider network behavior. Run live certification only with your own credentials and record the provider/API versions tested.
