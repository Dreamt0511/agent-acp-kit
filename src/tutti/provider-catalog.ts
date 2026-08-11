import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import {
  loadTuttiAgentCatalog,
  parseTuttiAgentCatalog,
  type LoadTuttiAgentCatalogInput,
} from "./agent-catalog.js";
import type {
  TuttiAgentCatalog,
  TuttiAgentProviderCatalog,
  TuttiAgentProviderCatalogEntry,
} from "./contracts.js";

/** @deprecated Use LoadTuttiAgentCatalogInput. */
export type LoadTuttiAgentProviderCatalogInput = LoadTuttiAgentCatalogInput;

/**
 * @deprecated Use loadTuttiAgentCatalog. Provider catalogs cannot represent
 * multiple exact agents that share one provider.
 */
export async function loadTuttiAgentProviderCatalog(
  input: LoadTuttiAgentProviderCatalogInput,
): Promise<TuttiAgentProviderCatalog> {
  return projectLegacyProviderCatalog(await loadTuttiAgentCatalog(input));
}

/** @deprecated Use parseTuttiAgentCatalog. */
export function parseTuttiAgentProviderCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
): TuttiAgentProviderCatalog {
  return projectLegacyProviderCatalog(parseTuttiAgentCatalog(payload, runtime));
}

function projectLegacyProviderCatalog(catalog: TuttiAgentCatalog): TuttiAgentProviderCatalog {
  const groups = new Map<string, typeof catalog.agents>();
  for (const agent of catalog.agents) {
    const group = groups.get(agent.providerId) ?? [];
    group.push(agent);
    groups.set(agent.providerId, group);
  }
  const providers = [...groups.entries()].map(([providerId, agents]) => {
    const agent = agents[0]!;
    if (agents.length === 1) {
      return {
        providerId,
        displayName: agent.displayName,
        agentTargetId: agent.agentTargetId,
        availability: agent.availability,
        runtimeSupported: agent.runtimeSupported,
      } satisfies TuttiAgentProviderCatalogEntry;
    }
    return {
      providerId,
      displayName: agent.displayName,
      availability: {
        status: "unavailable" as const,
        reasonCode: "agent_provider_ambiguous",
        detail: "Multiple agents use this provider; select an exact agent target instead.",
      },
      runtimeSupported: false,
    } satisfies TuttiAgentProviderCatalogEntry;
  });
  const defaultAgent = catalog.agents.find(
    (agent) => agent.agentTargetId === catalog.defaultAgentTargetId,
  );
  const defaultProvider = defaultAgent
    ? providers.find(
        (provider) =>
          provider.providerId === defaultAgent.providerId &&
          provider.agentTargetId === defaultAgent.agentTargetId,
      )
    : undefined;
  return {
    schemaVersion: 2,
    source: catalog.source,
    defaultProviderId:
      defaultProvider?.providerId ??
      providers.find((provider) => provider.runtimeSupported)?.providerId ??
      providers[0]?.providerId ??
      "",
    providers,
  };
}
