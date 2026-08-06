import type { DetectContext } from "../core/detection.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import type {
  TuttiAgentCatalog,
  TuttiAgentCatalogEntry,
  TuttiAgentProviderAvailability,
} from "./contracts.js";
import { canonicalTuttiProviderId, isRecord, optionalString } from "./internal.js";

/** TSH shared-agent targets are not supported by this kit's local runtime path. */
const SHARED_AGENT_TARGET_PREFIX = "shared-agent:";

export interface LoadTuttiAgentCatalogInput extends Omit<TuttiCliJsonRequest, "args"> {
  runtime: LocalAgentRuntime<string, string>;
}

export async function loadTuttiAgentCatalog(
  input: LoadTuttiAgentCatalogInput,
): Promise<TuttiAgentCatalog> {
  if (!hasConfiguredTuttiCli(input)) {
    return await loadStandaloneAgentCatalog(input.runtime, input.detectContext);
  }

  try {
    const payload = await runTuttiCliJson({
      ...input,
      args: ["--json", "agent", "list"],
    });
    return parseCliAgentCatalog(payload, input.runtime, input.detectContext);
  } catch (error) {
    if (!isMissingAgentIdContract(error)) throw error;
  }

  const legacyPayload = await runTuttiCliJson({
    ...input,
    args: ["--json", "agent", "providers"],
  });
  return parseLegacyProviderCatalog(legacyPayload, input.runtime, input.detectContext);
}

export function parseTuttiAgentCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
): TuttiAgentCatalog {
  return parseCliAgentCatalog(payload, runtime);
}

export function parseTuttiLegacyAgentProviderCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
): TuttiAgentCatalog {
  return parseLegacyProviderCatalog(payload, runtime);
}

export function isMissingAgentIdContract(error: unknown) {
  return error instanceof TuttiIntegrationError && error.code === "unsupported_command";
}

function parseCliAgentCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
  detectContext?: DetectContext,
): TuttiAgentCatalog {
  if (!isRecord(payload)) {
    throw invalidCatalog("Tutti agent catalog is not an object.");
  }
  if (payload.schemaVersion !== 1) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti agent catalog schema is unsupported.",
      {
        schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1,
      },
    );
  }
  if (typeof payload.defaultAgentTargetId !== "string" || !Array.isArray(payload.agents)) {
    throw invalidCatalog("Tutti agent catalog fields are invalid.");
  }

  const agents = withoutSharedAgents(
    parseCatalogEntries({
      values: payload.agents,
      runtime,
      detectContext,
      agentTargetIdField: "id",
      providerIdField: "provider",
      displayNameField: "name",
    }),
  );
  const defaultAgentTargetId = payload.defaultAgentTargetId.trim();
  const defaultPresent = agents.some((agent) => agent.agentTargetId === defaultAgentTargetId);
  const defaultWasShared = isSharedAgentTargetId(defaultAgentTargetId);
  if (
    (agents.length === 0 && defaultAgentTargetId !== "" && !defaultWasShared) ||
    (agents.length > 0 && !defaultPresent && !defaultWasShared)
  ) {
    throw invalidCatalog("Tutti agent catalog defaultAgentTargetId is invalid.");
  }
  return normalizedCatalog(
    agents,
    "tutti-cli",
    "agent-id",
    defaultPresent ? defaultAgentTargetId : undefined,
  );
}

function parseLegacyProviderCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
  detectContext?: DetectContext,
): TuttiAgentCatalog {
  if (!isRecord(payload)) {
    throw invalidCatalog("Tutti legacy provider catalog is not an object.");
  }
  if (payload.schemaVersion !== 2) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti legacy provider catalog schema is unsupported.",
      {
        schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1,
      },
    );
  }
  if (!Array.isArray(payload.providers)) {
    throw invalidCatalog("Tutti legacy provider catalog fields are invalid.");
  }

  const agents = withoutSharedAgents(
    parseCatalogEntries({
      values: payload.providers,
      runtime,
      detectContext,
      agentTargetIdField: "agentTargetId",
      providerIdField: "providerId",
      displayNameField: "displayName",
    }),
  );
  const requestedDefaultProvider = canonicalTuttiProviderId(
    optionalString(payload.defaultProviderId) ?? "",
  );
  const preferred = uniqueAgentForProvider(agents, requestedDefaultProvider);
  return normalizedCatalog(agents, "tutti-cli", "provider-compat", preferred?.agentTargetId);
}

function parseCatalogEntries(input: {
  values: unknown[];
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">;
  detectContext?: DetectContext;
  agentTargetIdField: string;
  providerIdField: string;
  displayNameField: string;
}) {
  const runtimeProviderIds = new Set(
    input.runtime.listProviders().map((provider) => String(provider.id)),
  );
  const seen = new Set<string>();
  return input.values.map((value, index) => {
    if (!isRecord(value)) {
      throw invalidCatalog(`Tutti agent catalog entry ${index} is invalid.`);
    }
    const agentTargetId = requiredString(
      value[input.agentTargetIdField],
      `agents[${index}].agentTargetId`,
    );
    if (seen.has(agentTargetId)) {
      throw invalidCatalog(`Tutti agent catalog contains duplicate agent ${agentTargetId}.`);
    }
    seen.add(agentTargetId);
    const providerId = canonicalTuttiProviderId(
      requiredString(value[input.providerIdField], `agents[${index}].providerId`),
    );
    const runtimeRegistered = runtimeProviderIds.has(providerId);
    const runtimeSupported = runtimeRegistered;
    const platformAvailability = parseAvailability(value.availability, index);
    const executablePath = optionalString(value.executablePath);
    const availability = runtimeSupported
      ? platformAvailability
      : {
          status: "unavailable" as const,
          reasonCode: "kit_runtime_unavailable",
          detail: "The installed agent-acp-kit cannot execute this agent runtime.",
        };
    return {
      agentTargetId,
      providerId,
      displayName: requiredString(value[input.displayNameField], `agents[${index}].displayName`),
      ...(executablePath ? { executablePath } : {}),
      availability,
      runtimeSupported,
    } satisfies TuttiAgentCatalogEntry;
  });
}

async function loadStandaloneAgentCatalog(
  runtime: LocalAgentRuntime<string, string>,
  detectContext?: DetectContext,
): Promise<TuttiAgentCatalog> {
  const descriptors = runtime.listProviders();
  const detections = await runtime.detect(detectContext);
  const byProvider = new Map(
    detections.map((detection) => [String(detection.provider), detection]),
  );
  const agents = descriptors.map((descriptor) => {
    const providerId = String(descriptor.id);
    const runtimeSupported = true;
    return {
      agentTargetId: `local:${providerId}`,
      providerId,
      displayName: descriptor.displayName,
      availability: standaloneAvailability(byProvider.get(providerId)),
      runtimeSupported,
    } satisfies TuttiAgentCatalogEntry;
  });
  return normalizedCatalog(agents, "standalone", "agent-id");
}

function withoutSharedAgents(agents: TuttiAgentCatalogEntry[]): TuttiAgentCatalogEntry[] {
  return agents.filter((agent) => !isSharedAgentTargetId(agent.agentTargetId));
}

function isSharedAgentTargetId(agentTargetId: string): boolean {
  return agentTargetId.startsWith(SHARED_AGENT_TARGET_PREFIX);
}

function normalizedCatalog(
  agents: TuttiAgentCatalogEntry[],
  source: TuttiAgentCatalog["source"],
  cliContract: TuttiAgentCatalog["cliContract"],
  preferredAgentTargetId?: string,
): TuttiAgentCatalog {
  const preferred = agents.find((agent) => agent.agentTargetId === preferredAgentTargetId);
  const usableDefault =
    preferred ??
    agents.find((agent) => agent.runtimeSupported && agent.availability.status === "available") ??
    agents.find((agent) => agent.runtimeSupported) ??
    agents[0];
  return {
    schemaVersion: 1,
    source,
    cliContract,
    defaultAgentTargetId: usableDefault?.agentTargetId ?? "",
    agents,
  };
}

function uniqueAgentForProvider(agents: TuttiAgentCatalogEntry[], providerId: string) {
  const matches = agents.filter((agent) => agent.providerId === providerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function standaloneAvailability(
  detection: Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>[number] | undefined,
): TuttiAgentProviderAvailability {
  if (!detection) {
    return {
      status: "unavailable",
      reasonCode: "runtime_not_detected",
      detail: "Agent runtime was not detected.",
    };
  }
  if (!detection.supported) {
    return {
      status: "unavailable",
      reasonCode: "provider_unsupported",
      detail: detection.reason ?? "Agent runtime is unsupported.",
    };
  }
  return { status: "available", reasonCode: "", detail: "" };
}

function parseAvailability(value: unknown, index: number): TuttiAgentProviderAvailability {
  if (!isRecord(value)) {
    throw invalidCatalog(`Tutti agent catalog availability ${index} is invalid.`);
  }
  if (
    value.status !== "available" &&
    value.status !== "unavailable" &&
    value.status !== "unknown"
  ) {
    throw invalidCatalog(`Tutti agent catalog availability status ${index} is invalid.`);
  }
  return {
    status: value.status,
    reasonCode: optionalString(value.reasonCode) ?? "",
    detail: optionalString(value.detail) ?? "",
  };
}

function invalidCatalog(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}

function requiredString(value: unknown, field: string) {
  const normalized = optionalString(value);
  if (!normalized) {
    throw invalidCatalog(`Tutti agent catalog ${field} is invalid.`);
  }
  return normalized;
}
