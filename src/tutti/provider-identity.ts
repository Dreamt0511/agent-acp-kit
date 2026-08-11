import { createDefaultLocalAgentProviderPlugins } from "../providers/acp-presets/provider.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import { createTuttiProviderResolver } from "./internal.js";

// Tutti's server integration only normalizes providers registered by the
// official default runtime. Unknown/third-party provider ids remain unchanged.
const officialProviderResolver = createTuttiProviderResolver(
  createDefaultLocalAgentProviderPlugins().map((provider) => ({
    id: String(provider.id),
    ...(provider.aliases?.length ? { aliases: provider.aliases.map(String) } : {}),
  })),
);

export function createRuntimeTuttiProviderResolver(
  runtime?: Pick<LocalAgentRuntime<string, string>, "listProviders">,
) {
  if (!runtime) return officialProviderResolver;
  return createTuttiProviderResolver(
    runtime.listProviders().map((provider) => ({
      id: String(provider.id),
      ...(provider.aliases?.length ? { aliases: provider.aliases.map(String) } : {}),
    })),
  );
}
