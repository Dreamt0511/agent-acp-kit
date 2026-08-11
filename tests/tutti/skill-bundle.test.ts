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
      if (args.includes("list")) {
        return {
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
      }
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

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      "--json",
      "agent",
      "list",
      "--agent-id",
      "local:codex",
    ]);
    expect(calls[1]?.args).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--agent-id",
      "local:codex",
      "--agent-session-id",
      "run-1",
    ]);
    expect(calls[1]?.options).toMatchObject({
      cwd: "/workspace",
      maxBuffer: 456,
      timeoutMs: 123,
    });
    expect(calls[1]?.options.redactionSecrets).toEqual([]);
    expect(context.skills).toHaveLength(1);
    expect(context.source).toBe("tutti-cli");
    expect(context.skillManifest).toBe(context.skills);
    expect(context.recommendedSystemPrompt?.content).toBe("Use Tutti skills.");
  });

  it("falls back to the old provider selector for an old daemon", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      agentTargetId: "local:codex",
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          throw new TuttiIntegrationError("unsupported_command", "unknown command");
        }
        if (args.includes("providers")) {
          return {
            schemaVersion: 2,
            defaultProviderId: "codex",
            providers: [
              {
                providerId: "codex",
                displayName: "Codex",
                agentTargetId: "local:codex",
                availability: {
                  status: "available",
                  reasonCode: "",
                  detail: "",
                },
              },
            ],
          };
        }
        return { schemaVersion: 1, provider: "codex", skills: [] };
      },
    });
    expect(calls).toEqual([
      ["--json", "agent", "list", "--agent-id", "local:codex"],
      ["--json", "agent", "providers"],
      ["--json", "agent", "tutti-cli-skill-bundle", "--provider", "codex"],
    ]);
    expect(bundle).toMatchObject({
      schemaVersion: 2,
      agentTargetId: "local:codex",
      providerId: "codex",
    });
  });

  it.each([
    ["extension:hermes", "acp:hermes", "hermes"],
    ["extension:kimi-code", "acp:kimi-code", "kimi"],
  ])(
    "keeps %s target, wire provider, and runtime provider identities distinct",
    async (agentTargetId, wireProviderId, runtimeProviderId) => {
      const calls: string[][] = [];
      const bundle = await loadTuttiAgentSkillBundle({
        agentTargetId,
        runTuttiCli: async (args) => {
          calls.push(args);
          if (args.includes("list")) {
            return {
              schemaVersion: 1,
              defaultAgentTargetId: agentTargetId,
              agents: [
                {
                  id: agentTargetId,
                  name: agentTargetId,
                  provider: wireProviderId,
                  availability: { status: "available", reasonCode: "", detail: "" },
                },
              ],
            };
          }
          return {
            schemaVersion: 2,
            agentTargetId,
            provider: wireProviderId,
            skills: [],
          };
        },
      });

      expect(calls[1]).toEqual([
        "--json",
        "agent",
        "tutti-cli-skill-bundle",
        "--agent-id",
        agentTargetId,
      ]);
      expect(bundle).toMatchObject({
        agentTargetId,
        providerId: runtimeProviderId,
        wireProviderId,
      });
    },
  );

  it("uses the old daemon's raw extension provider id without leaking it as runtime identity", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      agentTargetId: "extension:kimi-code",
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          throw new TuttiIntegrationError("unsupported_command", "unknown command");
        }
        if (args.includes("providers")) {
          return {
            schemaVersion: 2,
            defaultProviderId: "acp:kimi-code",
            providers: [
              {
                providerId: "acp:kimi-code",
                displayName: "Kimi Code",
                agentTargetId: "extension:kimi-code",
                availability: { status: "available", reasonCode: "", detail: "" },
              },
            ],
          };
        }
        return { schemaVersion: 1, provider: "acp:kimi-code", skills: [] };
      },
    });

    expect(calls[2]).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--provider",
      "acp:kimi-code",
    ]);
    expect(bundle).toMatchObject({
      agentTargetId: "extension:kimi-code",
      providerId: "kimi",
      wireProviderId: "acp:kimi-code",
    });
  });

  it("rejects old-daemon skill fallback when the provider cannot prove the exact target", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        agentTargetId: "team:codex-one",
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
                displayName: "Codex Two",
                agentTargetId: "team:codex-two",
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
    ).rejects.toMatchObject({ code: "agent_ambiguous" });
  });

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
      ["--json", "agent", "list", "--agent-id", "local:codex"],
    ]);
  });

  it("uses a lifecycle-sized timeout for exact-target skill preparation", async () => {
    const observed: Array<{ args: string[]; timeoutMs: number }> = [];
    await loadTuttiAgentSkillBundle({
      agentTargetId: "extension:hermes",
      runTuttiCli: async (args, options) => {
        observed.push({ args, timeoutMs: options.timeoutMs });
        if (args.includes("list")) {
          return {
            schemaVersion: 1,
            defaultAgentTargetId: "extension:hermes",
            agents: [
              {
                id: "extension:hermes",
                name: "Hermes Agent",
                provider: "acp:hermes",
                availability: { status: "available", reasonCode: "", detail: "" },
              },
            ],
          };
        }
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
          "list",
          "--agent-id",
          "extension:hermes",
        ],
        timeoutMs: 60_000,
      },
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
      provider: "codex",
      signal: controller.signal,
      runTuttiCli: async (args, options) => {
        calls.push({ args, signal: options.signal });
        return { schemaVersion: 1, provider: "codex", skills: [] };
      },
    });
    expect(calls[0]?.args).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--provider",
      "codex",
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
      provider: "codex",
      runTuttiCli: async (_args, options) => {
        expect(options.redactionSecrets).toEqual(["existing-secret"]);
        return { schemaVersion: 1, provider: "codex", skills: [] };
      },
    });
  });

  it("checks provider and session echo values", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        provider: "codex",
        runTuttiCli: async () => ({
          schemaVersion: 1,
          provider: "claude",
          agentSessionId: "expected-run",
          skills: [],
        }),
      }),
    ).rejects.toThrow("Tutti skill bundle provider mismatch: expected codex, got claude-code");

    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        provider: "codex",
        runTuttiCli: async () => ({
          schemaVersion: 1,
          provider: "codex",
          agentSessionId: "other-run",
          skills: [],
        }),
      }),
    ).rejects.toThrow("Tutti skill bundle session mismatch: expected expected-run, got other-run");
  });

  it("accepts legacy Claude only at ingress and exposes canonical output", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      provider: "claude",
      runTuttiCli: async (args) => {
        calls.push(args);
        return { schemaVersion: 1, provider: "claude", skills: [] };
      },
    });
    expect(calls[0]).toEqual([
      "--json",
      "agent",
      "tutti-cli-skill-bundle",
      "--provider",
      "claude-code",
    ]);
    expect(bundle.provider).toBe("claude-code");
    expect(
      parseTuttiAgentSkillBundle({
        schemaVersion: 1,
        provider: "claude",
        skills: [],
      }).provider,
    ).toBe("claude-code");
  });

  it("preserves a deprecated provider-only extension alias on the old daemon wire", async () => {
    const calls: string[][] = [];
    const bundle = await loadTuttiAgentSkillBundle({
      provider: "acp:kimi-code",
      runTuttiCli: async (args) => {
        calls.push(args);
        return { schemaVersion: 1, provider: "acp:kimi-code", skills: [] };
      },
    });

    expect(calls).toEqual([
      [
        "--json",
        "agent",
        "tutti-cli-skill-bundle",
        "--provider",
        "acp:kimi-code",
      ],
    ]);
    expect(bundle).toMatchObject({
      providerId: "kimi",
      wireProviderId: "acp:kimi-code",
    });
  });

  it("parses skill bundle JSON strictly", () => {
    expect(
      parseTuttiAgentSkillBundle(
        JSON.stringify({
          schemaVersion: 1,
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
        schemaVersion: 1,
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
      expect.objectContaining({ code: "invalid_response" }),
    );

    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        provider: "codex",
        runTuttiCli: async () => ({
          schemaVersion: 1,
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
