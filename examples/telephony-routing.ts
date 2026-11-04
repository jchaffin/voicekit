import { InMemoryEventJournal } from "@jchaffin/voicekit-core";
import { createCommandEnvelope } from "@jchaffin/voicekit-protocol";
import { SessionController } from "@jchaffin/voicekit-session";

export type PhoneRoute = "billing" | "technical" | "general";

export function selectPhoneRoute(calledNumber: string, transcript: string): PhoneRoute {
  const normalized = transcript.toLowerCase();
  if (calledNumber.endsWith("200") || /\b(invoice|charge|refund|billing)\b/.test(normalized)) return "billing";
  if (calledNumber.endsWith("300") || /\b(error|broken|technical|offline)\b/.test(normalized)) return "technical";
  return "general";
}

/** Creates the durable lifecycle for an inbound call and moves it to the selected route. */
export async function routeInboundCall(input: {
  callId: string;
  calledNumber: string;
  firstUtterance: string;
}) {
  const journal = new InMemoryEventJournal();
  const session = new SessionController(input.callId, journal, {
    configuration: { channel: "pstn", calledNumber: input.calledNumber },
  });
  await session.handle(createCommandEnvelope(input.callId, { type: "session.provision", data: {} }));
  await session.handle(createCommandEnvelope(input.callId, { type: "session.connect", data: {} }));
  await session.handle(createCommandEnvelope(input.callId, { type: "session.ready", data: {} }));

  const route = selectPhoneRoute(input.calledNumber, input.firstUtterance);
  await session.handle(createCommandEnvelope(input.callId, {
    type: "session.handoff",
    data: {
      handoffId: `route-${input.callId}`,
      target: route,
      reason: `inbound route selected from called number and first utterance`,
    },
  }));
  return { route, state: session.state, events: session.events };
}
