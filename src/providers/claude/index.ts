import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { AgentEvent } from "../../core/events.js";
import type { RawAgentStream } from "../../core/transport.js";
import {
  normalizeMcpServerConfigs,
  type NormalizedLocalAgentMcpServerConfig,
} from "../../core/mcp.js";
import { resolveAgentPermissionSelection } from "../../core/permissions.js";
import { materializeSkillsIntoRoot } from "../../skills/materialize.js";
import { composePromptWithSkills } from "../../skills/prompt-injection.js";
import { runJsonlTransport } from "../../transports/jsonl/jsonl-transport.js";
import { createProviderRunWorkspaceManager } from "../run-workspace.js";
import { detectClaude } from "./detect.js";
import { buildClaudeLaunchPlan } from "./launch-plan.js";
import { createClaudeEventMapper } from "./parser.js";

async function* parseClaudeRawEvents(stream: RawAgentStream): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;
  const mapClaudeEvent = createClaudeEventMapper();
  for await (const item of stream) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    if (record?.type === "system" && record.subtype === "init") {
      const candidate = record.session_id ?? record.sessionId;
      if (typeof candidate === "string" && candidate.trim()) {
        sessionId = candidate;
      }
    }
    if (!record) {
      continue;
    }
    for (const event of mapClaudeEvent(record)) {
      if (event.type === "done" && sessionId && !event.sessionId) {
        yield { ...event, sessionId };
        continue;
      }
      yield event;
    }
  }
}

function envEntriesToObject(
  env: NormalizedLocalAgentMcpServerConfig["env"],
) {
  return Object.fromEntries(env.map((entry) => [entry.key, entry.value]));
}

function buildClaudeMcpConfig(
  servers: NormalizedLocalAgentMcpServerConfig[],
) {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (server.type === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.toolTimeoutMs ? { timeout: server.toolTimeoutMs } : {}),
        ...(server.env.length > 0 ? { env: envEntriesToObject(server.env) } : {}),
      };
      continue;
    }

    mcpServers[server.name] = {
      type: "stdio",
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.toolTimeoutMs ? { timeout: server.toolTimeoutMs } : {}),
      ...(server.env.length > 0 ? { env: envEntriesToObject(server.env) } : {}),
    };
  }
  return { mcpServers };
}

function collectMcpRedactionSecrets(
  servers: NormalizedLocalAgentMcpServerConfig[],
) {
  const secrets: string[] = [];
  for (const server of servers) {
    for (const entry of server.env) {
      secrets.push(entry.value);
    }
    if (server.type === "http" && server.headers) {
      secrets.push(...Object.values(server.headers));
    }
  }
  return secrets.filter((secret) => secret.length > 0);
}

async function materializeClaudeMcpConfig(params: {
  runRoot: string;
  mcpServers?: Parameters<typeof normalizeMcpServerConfigs>[0];
}) {
  const normalizedServers = normalizeMcpServerConfigs(params.mcpServers ?? []);
  if (normalizedServers.length === 0) {
    return {
      redactionSecrets: [] as string[],
    };
  }

  const configPath = join(params.runRoot, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify(buildClaudeMcpConfig(normalizedServers)),
    "utf8",
  );

  return {
    mcpConfigPath: configPath,
    redactionSecrets: collectMcpRedactionSecrets(normalizedServers),
  };
}

export function createClaudeProvider(): LocalAgentProviderPlugin<
  "local-agent",
  "claude-code"
> {
  const runWorkspaces = createProviderRunWorkspaceManager("claude");

  async function prepareLaunchPlan(
    params: Parameters<LocalAgentProviderPlugin<"local-agent", "claude-code">["buildLaunchPlan"]>[0],
  ) {
    params = {
      ...params,
      permission: resolveAgentPermissionSelection(params.permission),
    };
    const skillManifest = params.skillManifest ?? [];
    const needsRunRoot =
      skillManifest.some((skill) => skill.deliveryMode === "materialized-files") ||
      (params.mcpServers?.length ?? 0) > 0;
    if (!needsRunRoot) {
      return buildClaudeLaunchPlan(
        {
          ...params,
          prompt: composePromptWithSkills({
            prompt: params.prompt,
            ...(params.history ? { history: params.history } : {}),
            skills: skillManifest,
            ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          }),
        },
        params.executablePath ?? "claude",
      );
    }
    return runWorkspaces.prepare(params.runId, params.env, async (workspace) => {
      const runRoot = await workspace.getRoot();
      const skillsPromise = materializeSkillsIntoRoot(
        join(runRoot, "skills"),
        skillManifest,
      );
      const mcpConfigPromise = materializeClaudeMcpConfig({
        runRoot,
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      });
      const [skillsResult, mcpResult] = await Promise.allSettled([
        skillsPromise,
        mcpConfigPromise,
      ]);
      if (skillsResult.status === "rejected") throw skillsResult.reason;
      if (mcpResult.status === "rejected") throw mcpResult.reason;
      const materialized = skillsResult.value;
      const mcpConfig = mcpResult.value;
      const prompt = composePromptWithSkills({
        prompt: params.prompt,
        ...(params.history ? { history: params.history } : {}),
        skills: materialized,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      });
      const plan = buildClaudeLaunchPlan(
        {
          ...params,
          prompt,
        },
        params.executablePath ?? "claude",
        mcpConfig.mcpConfigPath
          ? { mcpConfigPath: mcpConfig.mcpConfigPath }
          : undefined,
      );

      if (mcpConfig.redactionSecrets.length === 0) {
        return plan;
      }

      return {
        ...plan,
        redactionSecrets: Array.from(
          new Set([...(plan.redactionSecrets ?? []), ...mcpConfig.redactionSecrets]),
        ),
      };
    });
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", "claude-code"> = {
    id: "claude-code",
    aliases: ["claude"],
    requiresKnownAuth: true,
    displayName: "Claude Code",
    kind: "local-agent",
    async detect(context) {
      return detectClaude({
        ...(context?.cwd ? { cwd: context.cwd } : {}),
        ...(context?.env ? { env: context.env } : {}),
      });
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: true,
        streaming: true,
        toolGateway: true,
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
      };
    },
    async buildLaunchPlan(params) {
      return {
        ...(await prepareLaunchPlan(params)),
        ...(params.model ? { model: params.model } : {}),
        runId: params.runId,
        transport: "jsonl",
      };
    },
    createAdapter() {
      let adapterRunId: string | undefined;
      return {
        buildLaunchPlan: async (params) => {
          if (adapterRunId) {
            throw new Error("Claude runtime adapters can prepare only one run.");
          }
          adapterRunId = params.runId;
          try {
            return {
              ...(await prepareLaunchPlan(params)),
              ...(params.model ? { model: params.model } : {}),
              runId: params.runId,
              transport: "jsonl",
            };
          } catch (error) {
            adapterRunId = undefined;
            throw error;
          }
        },
        capabilities: () => plugin.capabilities(),
        parseEvents: async function* (stream) {
          try {
            yield* parseClaudeRawEvents(stream);
          } finally {
            if (adapterRunId) {
              await runWorkspaces.cleanup(adapterRunId);
            }
          }
        },
      };
    },
    async *run(params) {
      const plan = {
        ...(await prepareLaunchPlan(params)),
        ...(params.model ? { model: params.model } : {}),
        runId: params.runId,
        transport: "jsonl" as const,
      };
      const mapClaudeEvent = createClaudeEventMapper();
      try {
        yield* runJsonlTransport(plan, mapClaudeEvent, params.signal);
      } finally {
        await runWorkspaces.cleanup(params.runId);
      }
    },
  };

  return plugin;
}

export const claudeProvider = createClaudeProvider();
