import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import type { DetectContext } from "../core/detection.js";
import { isAgentPermissionSemantic } from "../core/permissions.js";
import type {
  TuttiAgentComposerConfig,
  TuttiAgentComposerOption,
  TuttiAgentComposerOptions,
  TuttiAgentPermissionConfig,
  TuttiAgentCatalog,
  TuttiAgentCatalogEntry,
} from "./contracts.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import { loadTuttiAgentCatalog } from "./agent-catalog.js";
import { isRecord, optionalString } from "./internal.js";
import { resolveOfficialTuttiProvider } from "./provider-identity.js";

const DEFAULT_TUTTI_COMPOSER_TIMEOUT_MS = 45_000;

interface LoadTuttiAgentComposerOptionsBase extends Omit<TuttiCliJsonRequest, "args"> {
  runtime: LocalAgentRuntime<string, string>;
  locale?: string;
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
}

export type LoadTuttiAgentComposerOptionsInput = LoadTuttiAgentComposerOptionsBase &
  ({ agentTargetId: string; providerId?: never } | { agentTargetId?: never; providerId: string });

export async function loadTuttiAgentComposerOptions(
  input: LoadTuttiAgentComposerOptionsInput,
): Promise<TuttiAgentComposerOptions> {
  const catalog = await loadTuttiAgentCatalog(input);
  return loadTuttiAgentComposerOptionsWithCatalog(input, catalog);
}

/** Internal facade hook for callers that already loaded the visibility catalog. */
export async function loadTuttiAgentComposerOptionsWithCatalog(
  input: LoadTuttiAgentComposerOptionsInput,
  catalog: TuttiAgentCatalog,
): Promise<TuttiAgentComposerOptions> {
  const agent = resolveCatalogAgent(input, catalog);
  if (!agent) {
    throw new TuttiIntegrationError(
      "agent_not_found",
      "Agent is not present in the current agent catalog.",
      {
        agentTargetId: input.agentTargetId?.trim() ?? "",
        providerId: input.providerId?.trim() ?? "",
      },
    );
  }
  if (!agent.runtimeSupported) {
    throw new TuttiIntegrationError(
      "provider_runtime_unavailable",
      "The installed agent-acp-kit cannot execute this agent runtime.",
      {
        agentTargetId: agent.agentTargetId,
        providerId: agent.providerId,
        wireProviderId: agent.wireProviderId ?? agent.providerId,
      },
    );
  }
  if (
    catalog.cliContract === "provider-compat" &&
    catalog.agents.filter((candidate) => candidate.providerId === agent.providerId).length !== 1
  ) {
    throw new TuttiIntegrationError(
      "agent_ambiguous",
      "The old Tutti daemon cannot select this exact agent because its provider is shared.",
      {
        agentTargetId: agent.agentTargetId,
        providerId: agent.providerId,
        wireProviderId: agent.wireProviderId ?? agent.providerId,
      },
    );
  }

  if (hasConfiguredTuttiCli(input)) {
    const payload = await runTuttiCliJson({
      ...input,
      args: createComposerArgs(input, agent, catalog.cliContract),
      timeoutMs: input.timeoutMs ?? DEFAULT_TUTTI_COMPOSER_TIMEOUT_MS,
    });
    return parseTuttiAgentComposerOptions(payload, agent, "tutti-cli");
  }
  return await standaloneComposerOptions(input.runtime, agent, input.model, input.detectContext);
}

export function parseTuttiAgentComposerOptions(
  payload: unknown,
  expectedAgent: Pick<TuttiAgentCatalogEntry, "agentTargetId" | "providerId"> &
    Partial<Pick<TuttiAgentCatalogEntry, "wireProviderId">>,
  source: "tutti-cli" | "standalone" = "tutti-cli",
): TuttiAgentComposerOptions {
  if (!isRecord(payload)) throw invalidComposer("Tutti composer response is not an object.");
  if (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti composer options schema is unsupported.",
      {
        schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1,
      },
    );
  }
  const responseProviderId =
    optionalString(payload.providerId) ?? optionalString(payload.provider) ?? "";
  const responseRuntimeProviderId =
    resolveOfficialTuttiProvider(responseProviderId).runtimeProviderId;
  if (
    !responseProviderId ||
    responseRuntimeProviderId !== expectedAgent.providerId
  ) {
    throw invalidComposer("Tutti composer response provider does not match the request.");
  }
  const responseAgentTargetId = optionalString(payload.agentTargetId);
  if (payload.schemaVersion === 2 && responseAgentTargetId !== expectedAgent.agentTargetId) {
    throw invalidComposer("Tutti composer response agent does not match the request.");
  }
  return {
    schemaVersion: 2,
    source,
    agentTargetId: expectedAgent.agentTargetId,
    providerId: expectedAgent.providerId,
    wireProviderId: responseProviderId,
    effectiveSettings: isRecord(payload.effectiveSettings) ? payload.effectiveSettings : {},
    modelConfig: parseComposerConfig(payload.modelConfig, "modelConfig"),
    permissionConfig: parsePermissionConfig(payload.permissionConfig),
    reasoningConfig: parseComposerConfig(payload.reasoningConfig, "reasoningConfig"),
    speedConfig: parseComposerConfig(payload.speedConfig, "speedConfig"),
  };
}

async function standaloneComposerOptions(
  runtime: LocalAgentRuntime<string, string>,
  agent: Pick<TuttiAgentCatalogEntry, "agentTargetId" | "providerId" | "wireProviderId">,
  selectedModel?: string,
  detectContext?: DetectContext,
): Promise<TuttiAgentComposerOptions> {
  const detection = (await runtime.detect(detectContext)).find(
    (entry) => String(entry.provider) === agent.providerId,
  );
  const options = (detection?.models ?? []).map((model) => ({
    id: model.id,
    value: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
  }));
  const defaultValue = options[0]?.value ?? "";
  const currentValue = optionalString(selectedModel) ?? defaultValue;
  const unavailableConfig = emptyComposerConfig();
  return {
    schemaVersion: 2,
    source: "standalone",
    agentTargetId: agent.agentTargetId,
    providerId: agent.providerId,
    wireProviderId: agent.wireProviderId ?? agent.providerId,
    effectiveSettings: currentValue ? { model: currentValue } : {},
    modelConfig: {
      configurable: options.length > 0,
      currentValue,
      defaultValue,
      options,
    },
    permissionConfig: { configurable: false, defaultValue: "", modes: [] },
    reasoningConfig: unavailableConfig,
    speedConfig: emptyComposerConfig(),
  };
}

function createComposerArgs(
  input: LoadTuttiAgentComposerOptionsInput,
  agent: Pick<
    TuttiAgentCatalogEntry,
    "agentTargetId" | "providerId" | "wireProviderId"
  >,
  cliContract: TuttiAgentCatalog["cliContract"],
) {
  return [
    "--json",
    "agent",
    "composer-options",
    cliContract === "agent-id" ? "--agent-id" : "--provider",
    cliContract === "agent-id"
      ? agent.agentTargetId
      : (agent.wireProviderId ?? agent.providerId),
    ...(optionalString(input.cwd) ? ["--cwd", optionalString(input.cwd)!] : []),
    ...(optionalString(input.locale) ? ["--locale", optionalString(input.locale)!] : []),
    ...(optionalString(input.model) ? ["--model", optionalString(input.model)!] : []),
    ...(optionalString(input.permissionMode)
      ? ["--permission-mode", optionalString(input.permissionMode)!]
      : []),
    ...(optionalString(input.reasoningEffort)
      ? ["--reasoning-effort", optionalString(input.reasoningEffort)!]
      : []),
  ];
}

function resolveCatalogAgent(
  input: LoadTuttiAgentComposerOptionsInput,
  catalog: TuttiAgentCatalog,
) {
  const agentTargetId = input.agentTargetId?.trim();
  if (agentTargetId) {
    return catalog.agents.find((agent) => agent.agentTargetId === agentTargetId);
  }
  const providerId = input.providerId?.trim() ?? "";
  const matches = catalog.agents.filter(
    (agent) => agent.providerId === providerId || agent.wireProviderId === providerId,
  );
  if (matches.length > 1) {
    throw new TuttiIntegrationError(
      "agent_ambiguous",
      "Multiple agents use this provider; select an exact agent target.",
      { providerId },
    );
  }
  return matches[0];
}

function parseComposerConfig(value: unknown, label: string): TuttiAgentComposerConfig {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw invalidComposer(`Tutti composer ${label} is invalid.`);
  }
  return {
    configurable: value.configurable === true,
    currentValue: optionalString(value.currentValue) ?? "",
    defaultValue: optionalString(value.defaultValue) ?? "",
    options: value.options.map((option, index) =>
      parseComposerOption(option, `${label}.options[${index}]`),
    ),
  };
}

function parseComposerOption(value: unknown, label: string): TuttiAgentComposerOption {
  if (!isRecord(value)) throw invalidComposer(`Tutti composer ${label} is invalid.`);
  const id = optionalString(value.id);
  const optionValue = optionalString(value.value);
  const optionLabel = optionalString(value.label);
  if (!id || !optionValue || !optionLabel) {
    throw invalidComposer(`Tutti composer ${label} fields are invalid.`);
  }
  return {
    id,
    value: optionValue,
    label: optionLabel,
    ...(optionalString(value.description)
      ? { description: optionalString(value.description) }
      : {}),
    ...(typeof value.supportsImageInput === "boolean"
      ? { supportsImageInput: value.supportsImageInput }
      : {}),
  };
}

function parsePermissionConfig(value: unknown): TuttiAgentPermissionConfig {
  if (!isRecord(value) || !Array.isArray(value.modes)) {
    throw invalidComposer("Tutti composer permissionConfig is invalid.");
  }
  return {
    configurable: value.configurable === true,
    defaultValue: optionalString(value.defaultValue) ?? "",
    modes: value.modes.map((mode, index) => {
      if (!isRecord(mode))
        throw invalidComposer(`Tutti composer permission mode ${index} is invalid.`);
      const id = optionalString(mode.id);
      const label = optionalString(mode.label);
      const semantic = optionalString(mode.semantic);
      if (!id || !label || !isAgentPermissionSemantic(semantic)) {
        throw invalidComposer(`Tutti composer permission mode ${index} fields are invalid.`);
      }
      return {
        id,
        label,
        semantic,
        ...(optionalString(mode.description)
          ? { description: optionalString(mode.description) }
          : {}),
      };
    }),
  };
}

function emptyComposerConfig(): TuttiAgentComposerConfig {
  return {
    configurable: false,
    currentValue: "",
    defaultValue: "",
    options: [],
  };
}

function invalidComposer(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}
