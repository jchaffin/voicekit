# @jchaffin/voicekit-provider-openai-live

Provider-independent VoiceKit adapter for the OpenAI GPT-Live API. It models the 2026 `live` endpoint and `gpt-live-1`; it is not an alias for the older Realtime API.

## What this package provides

- A typed network boundary (`OpenAILiveClient` and `OpenAILiveTransport`) for WebRTC, WebSocket, SIP, and sideband implementations.
- A stateful, idempotent `OpenAILiveController` that consumes raw or normalized GPT-Live server events.
- Full-duplex listening and speaking state, transcript fragments, interruption events, and VoiceKit protocol envelopes.
- Responses and client delegation, fixed when the session is created.
- Delegation lifecycle, tool-call and MCP confirmation requests, explicit task cancellation policy, duration usage, and separate backend token usage.
- A capability offer describing the adapter's supported transports and behaviors.

The package intentionally contains no pretend OpenAI SDK integration. Applications supply a real transport/client implemented with an official SDK, WebRTC, WebSocket, or telephony stack.

## Session and backend configuration

GPT-Live always uses `gpt-live-1` for the spoken conversation. The backend model or agent is configured independently.

```ts
import { createOpenAILiveController } from "@jchaffin/voicekit-provider-openai-live";

const controller = createOpenAILiveController({
  client: myOpenAILiveClient,
  options: {
    instructions: "Keep the conversation natural. Delegate account changes.",
    voice: "marin",
    backend: {
      type: "responses",
      model: "gpt-6-luna",
      instructions: "Apply account policy and use the registered tools.",
      serviceTier: "priority",
    },
  },
});

controller.onEvent((event) => {
  if (event.kind === "voicekit") {
    publishVoiceKitEnvelope(event.envelope);
  } else {
    observeProviderEvent(event.event);
  }
});

await controller.start({ kind: "webrtc", offerSdp });
```

For application-owned delegation, configure `backend.type: "client"` and optionally provide a `ClientDelegationExecutor`. The executor receives transcript fragments and an `AbortSignal`, and can stream `thinking` or `commentary` updates. A delegation event contains metadata, not the task text, so the application must retain conversation context.

## Transport descriptors

`OpenAILiveClient.createSession` receives an `OpenAILiveSessionCreateRequest` whose endpoint is always `live`, model is always `gpt-live-1`, and delegation mode matches the controller configuration. It returns an `OpenAILiveTransport` with one primary descriptor:

- `webrtc`: SDP answer, session ID, optional call ID, and optional sideband descriptor.
- `websocket`: URL and optional protocols.
- `sip`: call/session IDs, optional control URL, and optional sideband descriptor.
- `sideband`: a separate descriptor for attaching a trusted backend to an existing session.

WebRTC media belongs on media tracks; JSON events belong on its data channel. A WebSocket primary transport carries audio and events together. Sideband attaches to an existing session and does not create it or replay old events.

## Delegation and cancellation

Delegation mode cannot be changed in place:

- `responses`: OpenAI runs the selected Responses backend. Nested backend events arrive in `response.event`. Submit every required tool or approval result, then continue with `response.create`.
- `client`: the application runs any model, agent, or service and sends concise results through `session.commentary.append` or quiet progress through `session.thinking.append`.

The default cancellation policy is:

```ts
{
  onInterruption: "continue",
  onSessionClose: "cancel",
}
```

Voice interruption does not inherently cancel backend work. Set `onInterruption: "cancel"` only when interruption should abort application-owned client tasks. Closing a Live session follows OpenAI's own Responses behavior: queued work is cancelled, an active response may finish, and a response waiting for a function result cannot continue. `onSessionClose` controls client tasks only; choose `"detach"` when they must outlive the voice session.

`cancelDelegation` is idempotent and returns `false` for unknown or terminal tasks.

## Usage and graceful close

Voice usage is duration billing. `session.usage.updated` is cumulative seconds, not a delta. The controller ignores decreasing values and emits:

- package `usage` events with cumulative voice seconds;
- VoiceKit `usage.recorded` events in milliseconds;
- package `backend.usage` events for token usage from nested Responses completions.

Backend model and tool usage is billed separately from GPT-Live duration.

Call `controller.close()` to send `session.close`, then keep the transport alive. The controller releases it after `session.closed`. A final usage value is confirmed only when `session.closed` includes it. Use `forceClose()` for transport failure or an application timeout; this cannot confirm final usage.

## Event normalization

`consume` accepts either a `NormalizedOpenAILiveServerEvent` or a raw server event. `normalizeOpenAILiveServerEvent` recognizes current session lifecycle, transcript, speech, delegation, nested Responses, tool, approval, interruption, error, and usage events. Unknown future events remain observable as `provider.unknown`.

Server `event_id` is the idempotency key. Replayed IDs are ignored. Delegations also enforce one terminal transition, so duplicate completions with different event IDs cannot double-complete a task.

## Official API references

The contracts follow the current OpenAI documentation:

- [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live)
- [Delegation and tools in GPT-Live](https://developers.openai.com/api/docs/guides/live-delegation)
- [Managing GPT-Live conversations](https://developers.openai.com/api/docs/guides/live-conversations)
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [Server-side controls and sideband](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
