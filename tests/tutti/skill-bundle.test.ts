import { describe, expect, it } from "vitest";

import {
  loadTuttiAgentSkillBundle,
  loadTuttiAgentSkillContext,
  parseTuttiAgentSkillBundle,
  resolveTuttiCliCommand,
  TuttiIntegrationError,
  type TuttiCliJsonRunner,
} from "../../src/tutti/index.js";

describe("Tutti skill bundle helpers", () => {
  it("loads and validates the Tutti CLI skill bundle", async () => {
    const calls: Array<{
      args: string[];
      options: Parameters<TuttiCliJsonRunner>[1];
    }> = [];
    const runTuttiCli: TuttiCliJsonRunner = async (args, options) => {
      calls.push({ args, options });
      return {
        schemaVersion: 2,
        agentTargetId: "local:codex",
        provider: "codex",
        agentSessionId: "run-1",
        recommendedSystemPrompt: {
          format: "text/markdown",
          content: "Use Tutti skills.",
        },
        skills: [
          {
            skillId: "tutti/cli",
            slug: "tutti-cli",
            deliveryMode: "prompt-injection",
            content: "Use the Tutti CLI.",
          },
        ],
      };
    };

    const context = await loadTuttiAgentSkillContext({
      agentSessionId: "run-1",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      runTuttiCli,
      timeoutMs: 123,
      maxBuffer: 456,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--agent-id",
      "local:codex",
      "--agent-session-id",
      "run-1",
    ]);
    expect(calls[0]?.options).toMatchObject({
      cwd: "/workspace",
      maxBuffer: 456,
      timeoutMs: 123,
    });
    expect(calls[0]?.options.redactionSecrets).toEqual([]);
    expect(context.skills).toHaveLength(1);
    expect(context.source).toBe("tutti-cli");
    expect(context.skillManifest).toBe(context.skills);
    expect(context.recommendedSystemPrompt?.content).toBe("Use Tutti skills.");
  });

  it("rejects an old daemon response without retrying a provider selector", async () => {
    const calls: string[][] = [];
    await expect(
      loadTuttiAgentSkillBundle({
        agentTargetId: "local:codex",
        runTuttiCli: async (args) => {
          calls.push(args);
          return { schemaVersion: 1, provider: "codex", skills: [] };
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
    expect(calls).toEqual([
      ["--json", "agent", "tutti-cli-skill-bundle", "--agent-id", "local:codex"],
    ]);
  });

  it.each([
    ["extension:hermes", "acp:hermes", "hermes"],
    ["extension:kimi-code", "acp:kimi-code", "kimi"],
  ])(
    "keeps %s exact target while normalizing its runtime provider",
    async (agentTargetId, daemonProviderId, runtimeProviderId) => {
      const calls: string[][] = [];
      const bundle = await loadTuttiAgentSkillBundle({
        agentTargetId,
        runTuttiCli: async (args) => {
          calls.push(args);
          return {
            schemaVersion: 2,
            agentTargetId,
            provider: daemonProviderId,
            skills: [],
          };
        },
      });

      expect(calls[0]).toEqual([
        "--json",
        "agent",
        "tutti-cli-skill-bundle",
        "--agent-id",
        agentTargetId,
      ]);
      expect(bundle).toMatchObject({
        agentTargetId,
        providerId: runtimeProviderId,
      });
    },
  );

  it("does not use provider fallback for an ordinary configured CLI failure", async () => {
    const calls: string[][] = [];
    await expect(
      loadTuttiAgentSkillBundle({
        agentTargetId: "local:codex",
        runTuttiCli: async (args) => {
          calls.push(args);
          throw new Error("daemon unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "cli_execution_failed" });
    expect(calls).toEqual([
      ["--json", "agent", "tutti-cli-skill-bundle", "--agent-id", "local:codex"],
    ]);
  });

  it("uses a lifecycle-sized timeout for exact-target skill preparation", async () => {
    const observed: Array<{ args: string[]; timeoutMs: number }> = [];
    await loadTuttiAgentSkillBundle({
      agentTargetId: "extension:hermes",
      runTuttiCli: async (args, options) => {
        observed.push({ args, timeoutMs: options.timeoutMs });
        return {
          schemaVersion: 2,
          agentTargetId: "extension:hermes",
          provider: "acp:hermes",
          skills: [],
        };
      },
    });

    expect(observed).toEqual([
      {
        args: [
          "--json",
          "agent",
          "tutti-cli-skill-bundle",
          "--agent-id",
          "extension:hermes",
        ],
        timeoutMs: 60_000,
      },
    ]);
  });

  it("returns an empty bundle when no command is configured", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        env: {},
        provider: "codex",
      }),
    ).resolves.toEqual({ source: "standalone", skills: [] });
  });

  it("forwards browser, computer, and abort controls", async () => {
    const controller = new AbortController();
    const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
    await loadTuttiAgentSkillBundle({
      browserUse: true,
      computerUse: true,
      agentTargetId: "local:codex",
      signal: controller.signal,
      runTuttiCli: async (args, options) => {
        calls.push({ args, signal: options.signal });
        return {
          schemaVersion: 2,
          agentTargetId: "local:codex",
          provider: "codex",
          skills: [],
        };
      },
    });
    expect(calls[0]?.args).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--agent-id",
      "local:codex",
      "--browser-use",
      "--computer-use",
    ]);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("forwards detectContext to the CLI child projection", async () => {
    const detectContext = {
      redactionSecrets: ["existing-secret"],
    };
    await loadTuttiAgentSkillBundle({
      detectContext,
      agentTargetId: "local:codex",
      runTuttiCli: async (_args, options) => {
        expect(options.redactionSecrets).toEqual(["existing-secret"]);
        return {
          schemaVersion: 2,
          agentTargetId: "local:codex",
          provider: "codex",
          skills: [],
        };
      },
    });
  });

  it("checks exact target and session echo values", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        agentTargetId: "local:codex",
        runTuttiCli: async () => ({
          schemaVersion: 2,
          agentTargetId: "local:codex",
          provider: "codex",
          agentSessionId: "other-run",
          skills: [],
        }),
      }),
    ).rejects.toThrow("Tutti skill bundle session mismatch: expected expected-run, got other-run");
  });

  it("translates deprecated provider input to one exact target", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      provider: "claude",
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          return {
            schemaVersion: 1,
            defaultAgentTargetId: "local:claude-code",
            agents: [
              {
                id: "local:claude-code",
                name: "Claude Code",
                provider: "claude-code",
                availability: { status: "available", reasonCode: "", detail: "" },
              },
            ],
          };
        }
        return {
          schemaVersion: 2,
          agentTargetId: "local:claude-code",
          provider: "claude-code",
          skills: [],
        };
      },
    });
    expect(calls[0]).toEqual([
      "--json",
      "agent",
      "list",
    ]);
    expect(calls[1]).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--agent-id",
      "local:claude-code",
    ]);
    expect(bundle.provider).toBe("claude-code");
    expect(
      parseTuttiAgentSkillBundle({
        schemaVersion: 2,
        agentTargetId: "local:claude-code",
        provider: "claude",
        skills: [],
      }).provider,
    ).toBe("claude-code");
  });

  it("resolves a custom provider alias through runtime descriptors", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      provider: "acp:custom",
      runtime: {
        listProviders: () => [
          {
            id: "custom",
            aliases: ["acp:custom"],
            displayName: "Custom",
            kind: "local-agent",
          },
        ],
      },
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          return {
            schemaVersion: 1,
            defaultAgentTargetId: "extension:custom",
            agents: [
              {
                id: "extension:custom",
                name: "Custom",
                provider: "acp:custom",
                availability: { status: "available", reasonCode: "", detail: "" },
              },
            ],
          };
        }
        return {
          schemaVersion: 2,
          agentTargetId: "extension:custom",
          provider: "acp:custom",
          skills: [],
        };
      },
    });

    expect(calls).toEqual([
      [
        "--json",
        "agent",
        "list",
      ],
      [
        "--json",
        "agent",
        "tutti-cli-skill-bundle",
        "--agent-id",
        "extension:custom",
      ],
    ]);
    expect(bundle).toMatchObject({
      agentTargetId: "extension:custom",
      providerId: "custom",
    });
  });

  it("parses skill bundle JSON strictly", () => {
    expect(
      parseTuttiAgentSkillBundle(
        JSON.stringify({
          schemaVersion: 2,
          agentTargetId: "local:codex",
          provider: "codex",
          skills: [
            {
              skillId: "tutti/cli",
              slug: "tutti-cli",
              deliveryMode: "materialized-files",
              materializedPath: ".local-agent/tutti-cli",
              content: "# Tutti CLI",
              files: [{ path: "notes.md", content: "notes" }],
            },
          ],
        }),
      ).skills,
    ).toHaveLength(1);

    expect(() =>
      parseTuttiAgentSkillBundle({
        schemaVersion: 2,
        agentTargetId: "local:codex",
        provider: "codex",
        skills: [{}],
      }),
    ).toThrow("Tutti skill bundle contains an invalid skill record at index 0");
    expect(() => parseTuttiAgentSkillBundle("not json")).toThrow(
      "Tutti skill bundle response is not valid JSON",
    );
  });

  it("rejects missing or unsupported identity fields with typed errors", async () => {
    expect(() => parseTuttiAgentSkillBundle({ provider: "codex", skills: [] })).toThrow(
      expect.objectContaining({ code: "unsupported_schema" }),
    );
    expect(() =>
      parseTuttiAgentSkillBundle({
        schemaVersion: 2,
        provider: "codex",
        skills: [],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_response" }));
    expect(() => parseTuttiAgentSkillBundle({ schemaVersion: 1, skills: [] })).toThrow(
      expect.objectContaining({ code: "unsupported_schema" }),
    );

    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        agentTargetId: "local:codex",
        runTuttiCli: async () => ({
          schemaVersion: 2,
          agentTargetId: "local:codex",
          provider: "codex",
          skills: [],
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("resolves app-specific Tutti CLI env vars before the default", () => {
    expect(
      resolveTuttiCliCommand({
        env: {
          GROUP_CHAT_TUTTI_CLI: " /custom/tutti ",
          TUTTI_CLI: "/default/tutti",
        },
        envNames: ["GROUP_CHAT_TUTTI_CLI"],
      }),
    ).toBe("/custom/tutti");
    expect(resolveTuttiCliCommand({ env: { TUTTI_CLI: "/default/tutti" } })).toBe("/default/tutti");
  });
});
