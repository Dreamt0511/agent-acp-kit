import { describe, expect, it } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import {
  loadTuttiAgentComposerOptions,
  parseTuttiAgentComposerOptions,
  TuttiIntegrationError,
} from "../../src/tutti/index.js";

function runtime(): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    listProviders: () => [{ id: "codex", displayName: "Codex", kind: "local-agent" }],
    detect: async () => [
      {
        provider: "codex",
        displayName: "Codex",
        authState: "ok",
        supported: true,
        models: [{ id: "gpt-5", label: "GPT-5", description: "Default" }],
      },
    ],
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

const cliCatalog = {
  schemaVersion: 1,
  defaultAgentTargetId: "local:codex",
  agents: [
    {
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      availability: { status: "available", reasonCode: "", detail: "" },
    },
  ],
};

const cliComposer = {
  schemaVersion: 2,
  agentTargetId: "local:codex",
  provider: "codex",
  effectiveSettings: { model: "gpt-5", permissionModeId: "auto" },
  modelConfig: {
    configurable: true,
    currentValue: "gpt-5",
    defaultValue: "gpt-5",
    options: [{ id: "gpt-5", value: "gpt-5", label: "GPT-5" }],
  },
  permissionConfig: {
    configurable: true,
    defaultValue: "auto",
    modes: [{ id: "auto", label: "Auto", semantic: "auto" }],
  },
  reasoningConfig: {
    configurable: false,
    currentValue: "",
    defaultValue: "",
    options: [],
  },
  speedConfig: {
    configurable: false,
    currentValue: "",
    defaultValue: "",
    options: [],
  },
};

describe("Tutti composer options", () => {
  it("accepts another official alias for the same runtime provider", () => {
    expect(
      parseTuttiAgentComposerOptions(
        {
          ...cliComposer,
          agentTargetId: "extension:kimi-code",
          provider: "kimi-code",
        },
        {
          agentTargetId: "extension:kimi-code",
          providerId: "kimi",
        },
      ),
    ).toMatchObject({
      agentTargetId: "extension:kimi-code",
      providerId: "kimi",
    });
  });

  it("uses caller runtime aliases consistently for catalog and composer responses", async () => {
    const customRuntime = {
      ...runtime(),
      listProviders: () => [
        {
          id: "custom",
          aliases: ["acp:custom"],
          displayName: "Custom",
          kind: "local-agent",
        },
      ],
    } satisfies LocalAgentRuntime<string, string>;
    const options = await loadTuttiAgentComposerOptions({
      runtime: customRuntime,
      agentTargetId: "extension:custom",
      runTuttiCli: async (args) =>
        args.includes("list")
          ? {
              schemaVersion: 1,
              defaultAgentTargetId: "local:codex",
              agents: [
                {
                  id: "extension:custom",
                  name: "Custom",
                  provider: "acp:custom",
                  availability: { status: "available", reasonCode: "", detail: "" },
                },
              ],
            }
          : {
              ...cliComposer,
              agentTargetId: "extension:custom",
              provider: "acp:custom",
            },
    });
    expect(options).toMatchObject({
      agentTargetId: "extension:custom",
      providerId: "custom",
    });
  });

  it("loads options by exact agent id on the new contract", async () => {
    const calls: string[][] = [];
    const timeouts: number[] = [];
    const options = await loadTuttiAgentComposerOptions({
      runtime: runtime(),
      agentTargetId: "local:codex",
      cwd: "/workspace",
      runTuttiCli: async (args, runnerOptions) => {
        calls.push(args);
        timeouts.push(runnerOptions.timeoutMs);
        return args.includes("list") ? cliCatalog : cliComposer;
      },
    });
    expect(calls).toEqual([
      ["--json", "agent", "list", "--agent-id", "local:codex"],
      ["--json", "agent", "composer-options", "--agent-id", "local:codex", "--cwd", "/workspace"],
    ]);
    expect(options).toMatchObject({
      schemaVersion: 2,
      source: "tutti-cli",
      agentTargetId: "local:codex",
      providerId: "codex",
      modelConfig: { currentValue: "gpt-5" },
    });
    expect(timeouts).toEqual([60_000, 45_000]);
  });

  it("does not retry with the old provider selector", async () => {
    const calls: string[][] = [];
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        agentTargetId: "local:codex",
        runTuttiCli: async (args) => {
          calls.push(args);
          throw new TuttiIntegrationError("unsupported_command", "unknown command");
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_command" });
    expect(calls).toEqual([
      ["--json", "agent", "list", "--agent-id", "local:codex"],
    ]);
  });

  it("preserves a caller-provided timeout for catalog and composer", async () => {
    const timeouts: number[] = [];
    await loadTuttiAgentComposerOptions({
      runtime: runtime(),
      agentTargetId: "local:codex",
      timeoutMs: 12_345,
      runTuttiCli: async (args, runnerOptions) => {
        timeouts.push(runnerOptions.timeoutMs);
        return args.includes("list") ? cliCatalog : cliComposer;
      },
    });
    expect(timeouts).toEqual([12_345, 12_345]);
  });

  it("builds conservative standalone options with a stable agent id", async () => {
    const options = await loadTuttiAgentComposerOptions({
      env: {},
      runtime: runtime(),
      agentTargetId: "local:codex",
    });
    expect(options).toMatchObject({
      source: "standalone",
      agentTargetId: "local:codex",
      providerId: "codex",
      modelConfig: { configurable: true, defaultValue: "gpt-5" },
      permissionConfig: { configurable: false },
    });
  });

  it("reuses the same detectContext for standalone catalog and composer", async () => {
    const contexts: unknown[] = [];
    const standaloneRuntime = runtime();
    const baseDetect = standaloneRuntime.detect;
    standaloneRuntime.detect = async (context) => {
      contexts.push(context);
      return await baseDetect(context);
    };
    const detectContext = {
      redactionSecrets: ["request-secret"],
    };
    await loadTuttiAgentComposerOptions({
      detectContext,
      env: {},
      runtime: standaloneRuntime,
      agentTargetId: "local:codex",
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(detectContext);
    expect(contexts[1]).toBe(detectContext);
  });

  it("preserves the selected standalone model", async () => {
    const options = await loadTuttiAgentComposerOptions({
      env: {},
      runtime: runtime(),
      agentTargetId: "local:codex",
      model: "custom-model",
    });
    expect(options).toMatchObject({
      effectiveSettings: { model: "custom-model" },
      modelConfig: { currentValue: "custom-model", defaultValue: "gpt-5" },
    });
  });

  it("rejects unsupported composer schemas and mismatched agents", async () => {
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        agentTargetId: "local:codex",
        runTuttiCli: async (args) =>
          args.includes("list") ? cliCatalog : { ...cliComposer, schemaVersion: 3 },
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        agentTargetId: "local:codex",
        runTuttiCli: async (args) =>
          args.includes("list") ? cliCatalog : { ...cliComposer, agentTargetId: "other:codex" },
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects missing or unknown permission semantics", async () => {
    for (const semantic of [undefined, "provider-owned-superuser"]) {
      await expect(
        loadTuttiAgentComposerOptions({
          runtime: runtime(),
          agentTargetId: "local:codex",
          runTuttiCli: async (args) =>
            args.includes("list")
              ? cliCatalog
              : {
                  ...cliComposer,
                  permissionConfig: {
                    ...cliComposer.permissionConfig,
                    modes: [{ id: "auto", label: "Auto", semantic }],
                  },
                },
        }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("rejects agents absent from the live catalog", async () => {
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        agentTargetId: "future:agent",
        runTuttiCli: async () => {
          throw new TuttiIntegrationError("agent_not_found", "Agent Target was not found.");
        },
      }),
    ).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("keeps provider input only as an unambiguous compatibility adapter", async () => {
    const ambiguousCatalog = {
      schemaVersion: 1,
      defaultAgentTargetId: "local:codex",
      agents: [cliCatalog.agents[0], { ...cliCatalog.agents[0], id: "team:codex-two" }],
    };
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        providerId: "codex",
        runTuttiCli: async () => ambiguousCatalog,
      }),
    ).rejects.toMatchObject({ code: "agent_ambiguous" });
  });
});
