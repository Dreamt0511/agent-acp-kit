import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent } from "../../core/events.js";
import type { AgentDetectionDiagnostic } from "../../core/provider-plugin.js";
import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { RawAgentStream } from "../../core/transport.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { resolveAgentPermissionSelection } from "../../core/permissions.js";
import { materializeSkillsIntoRoot } from "../../skills/materialize.js";
import { composePromptWithSkills } from "../../skills/prompt-injection.js";
import { runAcpTransport } from "../../transports/acp/acp-client.js";
import { detectAcpModels } from "../../transports/acp/acp-models.js";
import { createProviderRunWorkspaceManager } from "../run-workspace.js";

export function createGenericAcpProvider(input: {
  command: string;
  displayName: string;
  providerId: string;
  aliases?: readonly string[];
  args: string[];
}) {
  const runWorkspaces = createProviderRunWorkspaceManager(input.providerId);

  async function* parseAcpEvents(
    stream: RawAgentStream,
  ): AsyncGenerator<AgentEvent> {
    for await (const item of stream) {
      yield item as AgentEvent;
    }
  }

  function toModelDiscoveryDiagnostic(error: unknown): AgentDetectionDiagnostic {
    return {
      message:
        error instanceof Error
          ? error.message
          : "ACP model discovery failed.",
      source: "acp-model-discovery",
    };
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", string> = {
    id: input.providerId,
    ...(input.aliases?.length ? { aliases: [...input.aliases] } : {}),
    displayName: input.displayName,
    kind: "local-agent",
    async detect(context) {
      let executablePath: string;
      try {
        executablePath = await resolveCommandExecutable({
          command: input.command,
          ...(context?.env ? { env: context.env } : {}),
        });
      } catch (error) {
        return {
          authState: "missing",
          executablePath: input.command,
          models: [],
          supported: false,
          unsupportedReason:
            error instanceof Error
              ? error.message
              : `Executable not found on PATH: ${input.command}`,
          version: "not-installed",
        };
      }
      let diagnostics: AgentDetectionDiagnostic[] | undefined;
      let models: Array<{ id: string; label: string }> = [];
      try {
        models = await detectAcpModels({
          args: input.args,
          bin: executablePath,
          cwd: context?.cwd ?? process.cwd(),
          ...(context?.env ? { env: context.env } : {}),
          ...(context?.redactionSecrets
            ? { redactionSecrets: context.redactionSecrets }
            : {}),
        });
      } catch (error) {
        diagnostics = [toModelDiscoveryDiagnostic(error)];
      }
      return {
        authState: "unknown",
        executablePath,
        ...(diagnostics ? { diagnostics } : {}),
        models,
        supported: true,
        version: "unknown",
      };
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: false,
        streaming: true,
        toolGateway: false,
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
      };
    },
    async buildLaunchPlan(params) {
      params = {
        ...params,
        permission: resolveAgentPermissionSelection(params.permission),
      };
      return runWorkspaces.prepare(params.runId, params.env, async (workspace) => {
        const runRoot = await workspace.getRoot();
        const providerTemp = join(runRoot, "tmp");
        await mkdir(providerTemp, { recursive: true });
        const skills = params.skillManifest ?? [];
        const materialized = skills.some(
          (skill) => skill.deliveryMode === "materialized-files",
        )
          ? await materializeSkillsIntoRoot(
              join(runRoot, "skills"),
              skills,
            )
          : skills;
        const prompt = composePromptWithSkills({
          prompt: params.prompt,
          ...(params.history ? { history: params.history } : {}),
          skills: materialized,
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        });
        return {
          args: input.args,
          command: params.executablePath ?? input.command,
          cwd: params.cwd,
          env: {
            ...(params.env ?? {}),
            TMPDIR: providerTemp,
            TEMP: providerTemp,
            TMP: providerTemp,
          },
          ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.permission ? { permission: params.permission } : {}),
          ...(params.resume ? { resume: params.resume } : {}),
          ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
          prompt,
          promptInput: "stdin" as const,
          runId: params.runId,
          transport: "acp-json-rpc" as const,
        };
      });
    },
    createAdapter() {
      let adapterRunId: string | undefined;
      return {
        buildLaunchPlan: async (params) => {
          if (adapterRunId) {
            throw new Error("Generic ACP runtime adapters can prepare only one run.");
          }
          adapterRunId = params.runId;
          try {
            return await plugin.buildLaunchPlan(params);
          } catch (error) {
            adapterRunId = undefined;
            throw error;
          }
        },
        capabilities: () => plugin.capabilities(),
        parseEvents: async function* (stream) {
          try {
            yield* parseAcpEvents(stream);
          } finally {
            if (adapterRunId) {
              await runWorkspaces.cleanup(adapterRunId);
            }
          }
        },
      };
    },
    async *run(params) {
      const plan = await plugin.buildLaunchPlan(params);
      const { mcpServers: _paramsMcpServers, ...paramsWithoutMcpServers } =
        params;
      try {
        yield* runAcpTransport(plan, {
          ...paramsWithoutMcpServers,
          ...(plan.mcpServers ? { mcpServers: plan.mcpServers } : {}),
          permission: resolveAgentPermissionSelection(plan.permission),
          cwd: plan.cwd,
          prompt: plan.prompt,
        });
      } finally {
        await runWorkspaces.cleanup(params.runId);
      }
    },
  };

  return plugin;
}
