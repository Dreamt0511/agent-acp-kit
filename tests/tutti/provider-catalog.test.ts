import { describe, expect, it, vi } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import {
  loadTuttiAgentCatalog,
  loadTuttiAgentProviderCatalog,
  TuttiIntegrationError,
} from "../../src/tutti/index.js";

function fakeRuntime(
  input: {
    providers?: Array<{
      id: string;
      displayName: string;
      kind: string;
      requiresKnownAuth?: boolean;
    }>;
    detections?: Array<Record<string, unknown>>;
  } = {},
): LocalAgentRuntime<string, string> {
  return {
    cancel: vi.fn(),
    listProviders: () =>
      input.providers ?? [
        { id: "codex", displayName: "Codex", kind: "local-agent" },
        {
          id: "claude-code",
          displayName: "Claude Code",
          kind: "local-agent",
          requiresKnownAuth: true,
        },
      ],
    detect: async () =>
      (input.detections ?? [
        {
          provider: "codex",
          displayName: "Codex",
          authState: "ok",
          supported: true,
          models: [],
        },
        {
          provider: "claude-code",
          displayName: "Claude Code",
          authState: "unknown",
          supported: false,
          reason: "Agent runtime was not detected.",
          models: [],
        },
      ]) as Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>,
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

const newCatalog = {
  schemaVersion: 1,
  defaultAgentTargetId: "local:codex",
  agents: [
    {
      id: "user:future",
      name: "Future Agent",
      provider: "future-agent",
      availability: { status: "available", reasonCode: "", detail: "" },
    },
    {
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      executablePath: "/resolved/bin/codex",
      availability: { status: "available", reasonCode: "", detail: "" },
    },
  ],
};

describe("Tutti agent catalog", () => {
  it("uses exact agent order and never adds runtime-only providers", async () => {
    const calls: string[][] = [];
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async (args) => {
        calls.push(args);
        return newCatalog;
      },
    });

    expect(calls).toEqual([["--json", "agent", "list"]]);
    expect(catalog).toMatchObject({
      schemaVersion: 1,
      source: "tutti-cli",
      cliContract: "agent-id",
      defaultAgentTargetId: "local:codex",
    });
    expect(catalog.agents.map((agent) => agent.agentTargetId)).toEqual([
      "user:future",
      "local:codex",
    ]);
    expect(catalog.agents[0]).toMatchObject({
      providerId: "future-agent",
      runtimeSupported: false,
      availability: {
        status: "unavailable",
        reasonCode: "kit_runtime_unavailable",
      },
    });
    expect(catalog.agents[1]?.executablePath).toBe("/resolved/bin/codex");
    expect(catalog.agents.some((agent) => agent.providerId === "claude-code")).toBe(false);
  });

  it("preserves the daemon default instead of guessing from availability or order", async () => {
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        ...newCatalog,
        defaultAgentTargetId: "user:future",
      }),
    });
    expect(catalog.defaultAgentTargetId).toBe("user:future");
    expect(catalog.agents[0]).toMatchObject({
      agentTargetId: "user:future",
      runtimeSupported: false,
    });
  });

  it("preserves multiple exact agents that share one provider", async () => {
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        schemaVersion: 1,
        defaultAgentTargetId: "team:codex-one",
        agents: [
          { ...newCatalog.agents[1], id: "team:codex-one" },
          { ...newCatalog.agents[1], id: "team:codex-two" },
        ],
      }),
    });
    expect(catalog.agents.map((agent) => agent.agentTargetId)).toEqual([
      "team:codex-one",
      "team:codex-two",
    ]);
  });

  it("omits shared-agent targets and reselects the default when needed", async () => {
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        schemaVersion: 1,
        defaultAgentTargetId: "shared-agent:shared-codex",
        agents: [
          {
            id: "shared-agent:shared-codex",
            name: "Shared Codex",
            provider: "codex",
            availability: { status: "available", reasonCode: "", detail: "" },
          },
          {
            id: "shared-agent:own-other-device-codex",
            name: "Own Other Device Codex",
            provider: "codex",
            availability: { status: "available", reasonCode: "", detail: "" },
          },
          newCatalog.agents[1],
          newCatalog.agents[0],
        ],
      }),
    });
    expect(catalog.agents.map((agent) => agent.agentTargetId)).toEqual([
      "local:codex",
      "user:future",
    ]);
    expect(catalog.defaultAgentTargetId).toBe("local:codex");
  });

  it("falls back to the old provider contract without inventing target ids", async () => {
    const calls: string[][] = [];
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          throw new TuttiIntegrationError("unsupported_command", "unknown command");
        }
        return {
          schemaVersion: 2,
          defaultProviderId: "claude",
          providers: [
            {
              providerId: "claude",
              displayName: "Claude Code",
              agentTargetId: "local:claude-code",
              availability: {
                status: "available",
                reasonCode: "",
                detail: "",
              },
            },
          ],
        };
      },
    });
    expect(calls).toEqual([
      ["--json", "agent", "list"],
      ["--json", "agent", "providers"],
    ]);
    expect(catalog).toMatchObject({
      cliContract: "provider-compat",
      defaultAgentTargetId: "local:claude-code",
      agents: [
        {
          agentTargetId: "local:claude-code",
          providerId: "claude-code",
          runtimeSupported: true,
        },
      ],
    });
  });

  it("rejects a legacy catalog that omits exact target identity", async () => {
    await expect(
      loadTuttiAgentCatalog({
        runtime: fakeRuntime(),
        runTuttiCli: async (args) => {
          if (args.includes("list")) {
            throw new TuttiIntegrationError("unsupported_command", "unknown command");
          }
          return {
            schemaVersion: 2,
            defaultProviderId: "codex",
            providers: [
              {
                providerId: "codex",
                displayName: "Codex",
                availability: {
                  status: "available",
                  reasonCode: "",
                  detail: "",
                },
              },
            ],
          };
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("automatically creates stable standalone agent ids", async () => {
    const catalog = await loadTuttiAgentCatalog({
      env: {},
      runtime: fakeRuntime(),
    });
    expect(catalog).toMatchObject({
      source: "standalone",
      defaultAgentTargetId: "local:codex",
      agents: [
        {
          agentTargetId: "local:codex",
          providerId: "codex",
          availability: { status: "available" },
        },
        {
          agentTargetId: "local:claude-code",
          providerId: "claude-code",
          availability: { status: "unavailable" },
        },
      ],
    });
  });

  it("keeps every registered runtime available in direct mode", async () => {
    const catalog = await loadTuttiAgentCatalog({
      runtime: fakeRuntime({
        providers: [
          { id: "opencode", displayName: "OpenCode", kind: "local-agent" },
          { id: "codex", displayName: "Codex", kind: "local-agent" },
        ],
      }),
      runTuttiCli: async () => ({
        schemaVersion: 1,
        defaultAgentTargetId: "local:codex",
        agents: [
          {
            id: "local:opencode",
            name: "OpenCode",
            provider: "opencode",
            availability: { status: "available", reasonCode: "", detail: "" },
          },
          newCatalog.agents[1],
        ],
      }),
    });
    expect(catalog.agents).toMatchObject([
      {
        agentTargetId: "local:opencode",
        runtimeSupported: true,
        availability: {
          status: "available",
        },
      },
      { agentTargetId: "local:codex", runtimeSupported: true },
    ]);
    expect(catalog.defaultAgentTargetId).toBe("local:codex");
  });

  it("does not silently use standalone discovery after both CLI contracts fail", async () => {
    const runtime = fakeRuntime();
    const detect = vi.spyOn(runtime, "detect");
    await expect(
      loadTuttiAgentCatalog({
        runtime,
        runTuttiCli: async () => {
          throw new Error("secret-output-must-not-leak");
        },
      }),
    ).rejects.toMatchObject<TuttiIntegrationError>({
      code: "cli_execution_failed",
      message: "Tutti CLI request failed.",
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it("does not hide malformed new-contract responses behind legacy fallback", async () => {
    const calls: string[][] = [];
    await expect(
      loadTuttiAgentCatalog({
        runtime: fakeRuntime(),
        runTuttiCli: async (args) => {
          calls.push(args);
          return { schemaVersion: 7, agents: [] };
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
    expect(calls).toEqual([["--json", "agent", "list"]]);
  });

  it("keeps the deprecated provider projection fail-closed for ambiguity", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        schemaVersion: 1,
        defaultAgentTargetId: "team:codex-one",
        agents: [
          { ...newCatalog.agents[1], id: "team:codex-one" },
          { ...newCatalog.agents[1], id: "team:codex-two" },
        ],
      }),
    });
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        providerId: "codex",
        runtimeSupported: false,
        availability: {
          status: "unavailable",
          reasonCode: "agent_provider_ambiguous",
          detail: expect.any(String),
        },
      }),
    ]);
  });
});
