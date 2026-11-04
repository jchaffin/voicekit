import {
  HandoffCoordinator,
  defineAgent,
  defineAgentGraph,
  delegate,
  replace,
  type HandoffRuntime,
} from "@jchaffin/voicekit-graph";

type GuestContext = {
  guestId: string;
  language: string;
  request: string;
  confirmed: boolean;
};

const concierge = defineAgent({
  id: "concierge",
  initialContext: (): GuestContext => ({
    guestId: "anonymous",
    language: "en",
    request: "",
    confirmed: false,
  }),
});
const reservations = defineAgent({ id: "reservations" });
const localGuide = defineAgent({ id: "local-guide" });

const reservationHandoff = replace({
  id: "concierge-to-reservations",
  from: concierge.id,
  to: reservations.id,
  projectContext: (source: GuestContext) => ({
    guestId: source.guestId,
    language: source.language,
    request: source.request,
    confirmed: source.confirmed,
  }),
  drainTimeoutMs: 2_000,
});

const guideConsult = delegate({
  id: "concierge-consults-guide",
  from: concierge.id,
  to: localGuide.id,
  projectContext: (source: GuestContext) => ({
    language: source.language,
    question: source.request,
  }),
});

export const conciergeGraph = defineAgentGraph({
  entry: concierge.id,
  agents: [concierge, reservations, localGuide],
  handoffs: [reservationHandoff, guideConsult],
});

export async function handoffReservation(
  context: GuestContext,
  runtime: HandoffRuntime<GuestContext, Awaited<ReturnType<typeof reservationHandoff.projectContext>>>,
) {
  if (!context.confirmed) throw new Error("Guest confirmation is required before reservation handoff");
  return new HandoffCoordinator().execute(reservationHandoff, context, runtime);
}

export async function consultLocalGuide(
  context: GuestContext,
  runtime: HandoffRuntime<GuestContext, Awaited<ReturnType<typeof guideConsult.projectContext>>>,
) {
  return new HandoffCoordinator().execute(guideConsult, context, runtime);
}
