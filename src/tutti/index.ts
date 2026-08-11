import type { SkillMaterializationFile, SkillMaterializationRecord } from "../core/skills.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import type { TuttiAgentIntegrationSource } from "./contracts.js";
import { createRuntimeTuttiProviderResolver } from "./provider-identity.js";

export { TuttiIntegrationError, resolveTuttiCliCommand } from "./cli-json-runner.js";
export { projectTuttiCliChildProcess, redactTuttiCliChildProcessText } from "./child-process.js";
export type {
  ResolveTuttiCliCommandInput,
  TuttiCliJsonRunner,
  TuttiIntegrationErrorCode,
} from "./cli-json-runner.js";
export type {
  ProjectTuttiCliChildProcessInput,
  TuttiCliChildProcessProjection,
} from "./child-process.js";
export {
  loadTuttiAgentCatalog,
  parseTuttiAgentCatalog,
} from "./agent-catalog.js";
export type { LoadTuttiAgentCatalogInput } from "./agent-catalog.js";
export {
  loadTuttiAgentProviderCatalog,
  parseTuttiAgentProviderCatalog,
} from "./provider-catalog.js";
export type { LoadTuttiAgentProviderCatalogInput } from "./provider-catalog.js";
export {
  loadTuttiAgentComposerOptions,
  parseTuttiAgentComposerOptions,
} from "./composer-options.js";
export type { LoadTuttiAgentComposerOptionsInput } from "./composer-options.js";
export * from "./contracts.js";

const DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER = 1024 * 1024;

export interface TuttiRecommendedSystemPrompt {
  content: string;
  format?: string;
}

export interface TuttiAgentSkillBundle {
  agentTargetId?: string;
  agentSessionId?: string;
  cliCommand?: string;
  providerId?: string;
  /** @deprecated Use providerId. */
  provider?: string;
  recommendedSystemPrompt?: TuttiRecommendedSystemPrompt;
  schemaVersion?: number;
  source: TuttiAgentIntegrationSource;
  skills: SkillMaterializationRecord[];
}

export interface TuttiAgentSkillContext extends TuttiAgentSkillBundle {
  skillManifest: SkillMaterializationRecord[];
}

interface LoadTuttiAgentSkillBundleBase extends Omit<TuttiCliJsonRequest, "args"> {
  agentSessionId?: string | null;
  browserUse?: boolean;
  computerUse?: boolean;
  /** Runtime descriptors used to resolve provider aliases in deprecated provider-only calls. */
  runtime?: Pick<LocalAgentRuntime<string, string>, "listProviders">;
}

export type LoadTuttiAgentSkillBundleInput = LoadTuttiAgentSkillBundleBase &
  (
    | { agentTargetId: string; provider?: never }
    | {
        agentTargetId?: never;
        /** @deprecated Use agentTargetId. */
        provider: string;
      }
  );

export type LoadTuttiAgentSkillContextInput = LoadTuttiAgentSkillBundleInput;

export async function loadTuttiAgentSkillBundle(
  input: LoadTuttiAgentSkillBundleInput,
): Promise<TuttiAgentSkillBundle> {
  if (!hasConfiguredTuttiCli(input)) {
    return { source: "standalone", skills: [] };
  }
  const requestedAgentTargetId = normalizeOptionalString(input.agentTargetId);
  const maxBuffer = input.maxBuffer ?? DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS;
  const cwd = normalizeOptionalString(input.cwd);

  const request = async (args: string[]) =>
    await runTuttiCliJson({
      args,
      command: input.command,
      commandEnvNames: input.commandEnvNames,
      detectContext: input.detectContext,
      ...(cwd ? { cwd } : {}),
      env: input.env,
      maxBuffer,
      runTuttiCli: input.runTuttiCli,
      signal: input.signal,
      timeoutMs,
    });

  let selection: { agentTargetId: string; providerId?: string };
  if (requestedAgentTargetId) {
    selection = { agentTargetId: requestedAgentTargetId };
  } else {
    const requestedProviderId = normalizeOptionalString(input.provider);
    if (!requestedProviderId) {
      throw invalidSkillBundle("Tutti skill bundle requires an exact agentTargetId");
    }
    const catalogPayload = await request(["--json", "agent", "list"]);
    selection = resolveProviderSkillSelection(
      catalogPayload,
      requestedProviderId,
      input.runtime,
    );
  }

  const payload = await request(createTuttiAgentSkillBundleArgs(input, selection.agentTargetId));
  const bundle = parseTuttiAgentSkillBundle(payload, input.runtime);
  assertTuttiAgentSkillBundleMatchesInput(bundle, input, selection);
  return bundle;
}

function resolveProviderSkillSelection(
  payload: unknown,
  requestedProviderId: string,
  runtime?: Pick<LocalAgentRuntime<string, string>, "listProviders">,
) {
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !Array.isArray(payload.agents)) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti agent catalog schema is unsupported.",
    );
  }
  const resolver = createRuntimeTuttiProviderResolver(runtime);
  const providerId = resolver.resolve(requestedProviderId);
  const matches = payload.agents.filter((value) => {
    if (!isRecord(value)) return false;
    const provider = normalizeUnknownString(value.provider);
    return provider ? resolver.resolve(provider) === providerId : false;
  });
  if (matches.length > 1) {
    throw new TuttiIntegrationError(
      "agent_ambiguous",
      "Multiple agents use this provider; select an exact agent target.",
      { providerId },
    );
  }
  if (matches.length !== 1 || !isRecord(matches[0])) {
    throw new TuttiIntegrationError(
      "agent_not_found",
      "Agent is not present in the current agent catalog.",
      { providerId },
    );
  }
  const agentTargetId = normalizeUnknownString(matches[0].id);
  if (!agentTargetId) {
    throw invalidSkillBundle("Tutti agent catalog target metadata is invalid");
  }
  return { agentTargetId, providerId };
}

export async function loadTuttiAgentSkillContext(
  input: LoadTuttiAgentSkillContextInput,
): Promise<TuttiAgentSkillContext> {
  const bundle = await loadTuttiAgentSkillBundle(input);

  return {
    ...bundle,
    skillManifest: bundle.skills,
  };
}

export function parseTuttiAgentSkillBundle(
  value: unknown,
  runtime?: Pick<LocalAgentRuntime<string, string>, "listProviders">,
): TuttiAgentSkillBundle {
  const payload =
    typeof value === "string" ? parseJsonRecord(value, "Tutti skill bundle response") : value;
  if (!isRecord(payload)) {
    throw invalidSkillBundle("Tutti skill bundle response is not an object");
  }
  if (payload.schemaVersion !== 2) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti skill bundle schema is unsupported.",
      {
        schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1,
      },
    );
  }
  const rawProvider = normalizeUnknownString(payload.provider);
  if (!rawProvider) {
    throw invalidSkillBundle("Tutti skill bundle response does not contain a valid provider");
  }
  const providerId = createRuntimeTuttiProviderResolver(runtime).resolve(rawProvider);
  const agentTargetId = normalizeUnknownString(payload.agentTargetId);
  if (!agentTargetId) {
    throw invalidSkillBundle("Tutti skill bundle response does not contain a valid agentTargetId");
  }
  if (payload.agentSessionId !== undefined && !normalizeUnknownString(payload.agentSessionId)) {
    throw invalidSkillBundle("Tutti skill bundle response contains an invalid agentSessionId");
  }
  if (!Array.isArray(payload.skills)) {
    throw invalidSkillBundle("Tutti skill bundle response does not contain a skills array");
  }

  const recommendedSystemPrompt = parseRecommendedSystemPrompt(payload.recommendedSystemPrompt);

  return {
    source: "tutti-cli",
    schemaVersion: payload.schemaVersion,
    agentTargetId,
    providerId,
    provider: providerId,
    ...(normalizeUnknownString(payload.agentSessionId)
      ? { agentSessionId: normalizeUnknownString(payload.agentSessionId) }
      : {}),
    ...(typeof payload.cliCommand === "string" ? { cliCommand: payload.cliCommand } : {}),
    ...(recommendedSystemPrompt ? { recommendedSystemPrompt } : {}),
    skills: payload.skills.map((item, index) => {
      if (!isSkillMaterializationRecord(item)) {
        throw invalidSkillBundle(
          `Tutti skill bundle contains an invalid skill record at index ${index}`,
        );
      }
      return item;
    }),
  };
}

function createTuttiAgentSkillBundleArgs(
  input: LoadTuttiAgentSkillBundleInput,
  agentTargetId: string,
): string[] {
  const agentSessionId = normalizeOptionalString(input.agentSessionId);
  return [
    "--json",
    "agent",
    "tutti-cli-skill-bundle",
    "--agent-id",
    agentTargetId,
    ...(agentSessionId ? ["--agent-session-id", agentSessionId] : []),
    ...(input.browserUse ? ["--browser-use"] : []),
    ...(input.computerUse ? ["--computer-use"] : []),
  ];
}

function assertTuttiAgentSkillBundleMatchesInput(
  bundle: TuttiAgentSkillBundle,
  input: LoadTuttiAgentSkillBundleInput,
  selection: { agentTargetId: string; providerId?: string },
) {
  if (selection.providerId && bundle.providerId !== selection.providerId) {
    throw invalidSkillBundle(
      `Tutti skill bundle provider mismatch: expected ${selection.providerId}, got ${bundle.providerId ?? ""}`,
    );
  }
  if (bundle.agentTargetId !== selection.agentTargetId) {
    throw invalidSkillBundle(
      `Tutti skill bundle agent mismatch: expected ${selection.agentTargetId}, got ${bundle.agentTargetId ?? ""}`,
    );
  }

  const expectedAgentSessionId = normalizeOptionalString(input.agentSessionId);
  if (expectedAgentSessionId && bundle.agentSessionId !== expectedAgentSessionId) {
    throw invalidSkillBundle(
      bundle.agentSessionId
        ? `Tutti skill bundle session mismatch: expected ${expectedAgentSessionId}, got ${bundle.agentSessionId}`
        : `Tutti skill bundle response does not contain agentSessionId ${expectedAgentSessionId}`,
    );
  }
}

function parseJsonRecord(value: string, label: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new TuttiIntegrationError(
      "invalid_response",
      `${label} is not valid JSON.`,
      {},
      { cause: error },
    );
  }
}

function parseRecommendedSystemPrompt(value: unknown): TuttiRecommendedSystemPrompt | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidSkillBundle("Tutti skill bundle recommendedSystemPrompt is not an object");
  }
  if (typeof value.content !== "string") {
    throw invalidSkillBundle("Tutti skill bundle recommendedSystemPrompt.content is not a string");
  }

  return {
    ...(typeof value.format === "string" ? { format: value.format } : {}),
    content: value.content,
  };
}

function isSkillMaterializationRecord(value: unknown): value is SkillMaterializationRecord {
  if (!isRecord(value)) return false;
  if (typeof value.skillId !== "string" || !value.skillId) return false;
  if (typeof value.slug !== "string" || !value.slug) return false;
  if (
    value.deliveryMode !== "materialized-files" &&
    value.deliveryMode !== "prompt-injection" &&
    value.deliveryMode !== "project-instructions"
  ) {
    return false;
  }
  if (value.content !== undefined && typeof value.content !== "string") {
    return false;
  }
  if (value.materializedPath !== undefined && typeof value.materializedPath !== "string") {
    return false;
  }
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) return false;
    return value.files.every(isSkillMaterializationFile);
  }
  return true;
}

function isSkillMaterializationFile(value: unknown): value is SkillMaterializationFile {
  return isRecord(value) && typeof value.path === "string" && typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUnknownString(value: unknown) {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function invalidSkillBundle(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}
