export function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalTuttiProviderId(providerId: string) {
  return providerId === "claude" ? "claude-code" : providerId;
}

export type TuttiProviderDescriptor = {
  id: string;
  aliases?: readonly string[];
};

/** Resolves daemon/CLI provider ids through the runtime's declared aliases. */
export function createTuttiProviderResolver(
  descriptors: readonly TuttiProviderDescriptor[],
) {
  const runtimeProviderByInput = new Map<string, string>();
  for (const descriptor of descriptors) {
    const runtimeProviderId = descriptor.id.trim();
    if (!runtimeProviderId) continue;
    runtimeProviderByInput.set(runtimeProviderId, runtimeProviderId);
    for (const alias of descriptor.aliases ?? []) {
      const normalizedAlias = alias.trim();
      if (normalizedAlias) runtimeProviderByInput.set(normalizedAlias, runtimeProviderId);
    }
  }

  return {
    resolve(providerId: string): string {
      const normalizedProviderId = providerId.trim();
      return (
        runtimeProviderByInput.get(normalizedProviderId) ??
        canonicalTuttiProviderId(normalizedProviderId)
      );
    },
  };
}
