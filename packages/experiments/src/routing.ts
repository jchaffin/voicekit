import { immutable } from "./crypto.js";
import type { Assignment, ExperimentRevision, ProviderRouting, RoutingPayload, VariantManifest } from "./types.js";

function variantFor(revision: ExperimentRevision, assignment: Assignment): VariantManifest {
  if (revision.experimentId !== assignment.experimentId || revision.revision !== assignment.revision) {
    throw new Error("Assignment does not belong to this experiment revision");
  }
  const variant = revision.variants.find((candidate) => candidate.id === assignment.variantId);
  if (!variant) throw new Error(`Variant "${assignment.variantId}" is absent from pinned revision`);
  return variant;
}

export function createRoutingPayload(revision: ExperimentRevision, assignment: Assignment): RoutingPayload {
  const routing = variantFor(revision, assignment).routing;
  let payload: Readonly<Record<string, unknown>>;
  switch (routing.provider) {
    case "elevenagents":
      payload = {
        branch_id: routing.branchId,
        ...(routing.conversationConfigOverride ? { conversation_config_override: routing.conversationConfigOverride } : {}),
      };
      break;
    case "livekit":
      payload = {
        agent_name: routing.agentName,
        ...(routing.deploymentId ? { deployment_id: routing.deploymentId } : {}),
        metadata: {
          ...(routing.metadata ?? {}),
          voicekit_experiment: assignment.experimentId,
          voicekit_variant: assignment.variantId,
          voicekit_assignment_revision: assignment.revision,
        },
      };
      break;
    case "openai":
      payload = {
        api: routing.api,
        session: routing.session,
        metadata: {
          voicekit_experiment: assignment.experimentId,
          voicekit_variant: assignment.variantId,
        },
      };
      break;
    case "pipecat":
      payload = {
        agent: routing.agent,
        body: {
          ...(routing.body ?? {}),
          voicekit_experiment: assignment.experimentId,
          voicekit_variant: assignment.variantId,
        },
      };
      break;
  }
  return immutable({ provider: routing.provider, payload, assignment });
}

export interface RoutingResolution {
  readonly owner: Assignment["routingOwner"];
  readonly payload?: RoutingPayload;
  readonly nativeContext?: Readonly<Record<string, unknown>>;
}

/**
 * VoiceKit-owned assignments produce a provider payload. Native-owned
 * assignments remain pinned but delegate branch selection to the provider.
 */
export function resolveRouting(
  revision: ExperimentRevision,
  assignment: Assignment,
  nativeContext?: Readonly<Record<string, unknown>>,
): RoutingResolution {
  return assignment.routingOwner === "voicekit"
    ? immutable({ owner: "voicekit", payload: createRoutingPayload(revision, assignment) })
    : immutable({
        owner: "native",
        nativeContext: {
          ...(nativeContext ?? {}),
          experimentId: assignment.experimentId,
          variantId: assignment.variantId,
          revision: assignment.revision,
        },
      });
}

export function routingProvider(routing: ProviderRouting): ProviderRouting["provider"] {
  return routing.provider;
}
