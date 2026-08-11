import { createDefaultLocalAgentProviderPlugins } from "../providers/acp-presets/provider.js";
import {
  createTuttiProviderResolver,
  type TuttiProviderIdentity,
} from "./internal.js";

// Tutti's server integration only normalizes providers registered by the
// official default runtime. Unknown/third-party provider ids remain unchanged.
const officialProviderResolver = createTuttiProviderResolver(
  createDefaultLocalAgentProviderPlugins().map((provider) => ({
    id: String(provider.id),
    ...(provider.aliases?.length ? { aliases: provider.aliases.map(String) } : {}),
  })),
);

export function resolveOfficialTuttiProvider(
  providerId: string,
): TuttiProviderIdentity {
  return officialProviderResolver.resolve(providerId);
}
