import { describe, expect, it } from "vitest";

import * as runtime from "../../src/index.js";
import * as testing from "../../src/testing/index.js";
import * as tutti from "../../src/tutti/index.js";

describe("public api", () => {
  it("exports the package facade, official providers, and core helpers", () => {
    expect(runtime.createLocalAgentRuntime).toBeTypeOf("function");
    expect(runtime.createDefaultLocalAgentRuntime).toBeTypeOf("function");
    expect(runtime.createCodexProvider).toBeTypeOf("function");
    expect(runtime.codexProvider.id).toBe("codex");
    expect(runtime.createClaudeProvider).toBeTypeOf("function");
    expect(runtime.claudeProvider.id).toBe("claude-code");
    expect(runtime.installAgentProvider).toBeTypeOf("function");
    expect(runtime.getAgentProviderInstallStatus).toBeTypeOf("function");
    expect(runtime.AGENT_PROVIDER_INSTALL_SPECS.codex.cliBinary).toBe("codex");
    expect(runtime.createDefaultLocalAgentProviderPlugins).toBeTypeOf("function");
    expect(runtime.DEFAULT_LOCAL_AGENT_PROVIDER_IDS).toEqual([
      "codex",
      "claude-code",
      "tutti-agent",
      "hermes",
      "kimi",
      "opencode",
      "cursor",
    ]);
    expect(runtime.createTuttiAgentProvider).toBeTypeOf("function");
    expect(runtime.tuttiAgentProvider.id).toBe("tutti-agent");
    expect(runtime.createDevinProvider).toBeTypeOf("function");
    expect(runtime.devinProvider.id).toBe("devin");
    expect(runtime.createHermesProvider).toBeTypeOf("function");
    expect(runtime.hermesProvider.id).toBe("hermes");
    expect(runtime.createKimiProvider).toBeTypeOf("function");
    expect(runtime.kimiProvider.id).toBe("kimi");
    expect(runtime.createKiroProvider).toBeTypeOf("function");
    expect(runtime.kiroProvider.id).toBe("kiro");
    expect(runtime.createKiloProvider).toBeTypeOf("function");
    expect(runtime.kiloProvider.id).toBe("kilo");
    expect(runtime.createMistralVibeProvider).toBeTypeOf("function");
    expect(runtime.mistralVibeProvider.id).toBe("vibe");
    expect(runtime.createCursorProvider).toBeTypeOf("function");
    expect(runtime.cursorProvider.id).toBe("cursor");
    expect(runtime.createGeminiProvider).toBeTypeOf("function");
    expect(runtime.geminiProvider.id).toBe("gemini");
    expect(runtime.createOpenCodeProvider).toBeTypeOf("function");
    expect(runtime.openCodeProvider.id).toBe("opencode");
    expect(runtime.createQoderProvider).toBeTypeOf("function");
    expect(runtime.qoderProvider.id).toBe("qoder");
    expect(runtime.createQwenProvider).toBeTypeOf("function");
    expect(runtime.qwenProvider.id).toBe("qwen");
    expect(runtime.fakeProvider.id).toBe("fake");
    expect(runtime.createGenericAcpProvider).toBeTypeOf("function");
    expect(runtime.normalizeMcpServerConfigs).toBeTypeOf("function");
    expect("createRuntimeControlPlane" in runtime).toBe(false);
    expect("inferRuntimeKind" in runtime).toBe(false);
    expect("spawnSupervisedProcess" in runtime).toBe(false);
    expect("runAcpTransport" in runtime).toBe(false);
  });

  it("exports testing helpers through the testing subpath", () => {
    expect(testing.assertProviderConformance).toBeTypeOf("function");
    expect(testing.createFakeRuntimeProvider).toBeTypeOf("function");
    expect(testing.createFakeAcpPeer).toBeTypeOf("function");
  });

  it("exports Tutti helpers through the Tutti subpath", () => {
    expect(tutti.loadTuttiAgentSkillBundle).toBeTypeOf("function");
    expect(tutti.loadTuttiAgentSkillContext).toBeTypeOf("function");
    expect(tutti.loadTuttiAgentProviderCatalog).toBeTypeOf("function");
    expect(tutti.loadTuttiAgentCatalog).toBeTypeOf("function");
    expect(tutti.loadTuttiAgentComposerOptions).toBeTypeOf("function");
    expect(tutti.parseTuttiAgentSkillBundle).toBeTypeOf("function");
    expect(tutti.resolveTuttiCliCommand).toBeTypeOf("function");
    expect(tutti.projectTuttiCliChildProcess).toBeTypeOf("function");
    expect(tutti.redactTuttiCliChildProcessText).toBeTypeOf("function");
  });
});
