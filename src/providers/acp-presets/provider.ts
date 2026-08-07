import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import { createClaudeProvider } from "../claude/index.js";
import {
  createCodexProvider,
  createTuttiAgentProvider,
} from "../codex/index.js";
import { createGenericAcpProvider } from "../generic-acp/provider.js";

export type AcpProviderSpec = {
  id: string;
  aliases?: readonly string[];
  displayName: string;
  command: string;
  args: readonly string[];
  binEnvKey: string;
  source: "acp-registry" | "open-design";
};

export const ACP_PROVIDER_SPECS = [
  {
    id: "devin",
    displayName: "Devin for Terminal",
    command: "devin",
    args: [
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
      "acp",
    ],
    binEnvKey: "DEVIN_ACP_BIN",
    source: "open-design",
  },
  {
    id: "hermes",
    aliases: ["acp:hermes"],
    displayName: "Hermes",
    command: "hermes",
    args: ["acp", "--accept-hooks"],
    binEnvKey: "HERMES_ACP_BIN",
    source: "open-design",
  },
  {
    id: "kimi",
    aliases: ["kimi-code", "acp:kimi-code"],
    displayName: "Kimi CLI",
    command: "kimi",
    args: ["acp"],
    binEnvKey: "KIMI_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "kiro",
    displayName: "Kiro CLI",
    command: "kiro-cli",
    args: ["acp"],
    binEnvKey: "KIRO_ACP_BIN",
    source: "open-design",
  },
  {
    id: "kilo",
    displayName: "Kilo",
    command: "kilo",
    args: ["acp"],
    binEnvKey: "KILO_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "vibe",
    displayName: "Mistral Vibe CLI",
    command: "vibe-acp",
    args: [],
    binEnvKey: "VIBE_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    command: "cursor-agent",
    args: ["acp"],
    binEnvKey: "CURSOR_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
    binEnvKey: "GEMINI_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    args: ["acp"],
    binEnvKey: "OPENCODE_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "qoder",
    displayName: "Qoder CLI",
    command: "qodercli",
    args: ["--acp"],
    binEnvKey: "QODER_ACP_BIN",
    source: "acp-registry",
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    command: "qwen",
    args: ["--acp", "--experimental-skills"],
    binEnvKey: "QWEN_ACP_BIN",
    source: "acp-registry",
  },
] as const satisfies readonly AcpProviderSpec[];

export type AcpProviderId = (typeof ACP_PROVIDER_SPECS)[number]["id"];

export const DEFAULT_LOCAL_AGENT_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "tutti-agent",
  "hermes",
  "kimi",
  "opencode",
  "cursor",
] as const;

function resolveProviderCommand(spec: AcpProviderSpec) {
  const override = process.env[spec.binEnvKey]?.trim();
  return override || spec.command;
}

export function createKnownAcpProvider(
  providerId: AcpProviderId,
): LocalAgentProviderPlugin<"local-agent", string> {
  const spec: AcpProviderSpec | undefined = ACP_PROVIDER_SPECS.find(
    (provider) => provider.id === providerId,
  );
  if (!spec) {
    throw new Error(`Unknown ACP provider id: ${providerId}`);
  }

  return createGenericAcpProvider({
    args: [...spec.args],
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    command: resolveProviderCommand(spec),
    displayName: spec.displayName,
    providerId: spec.id,
  });
}

export function createDevinProvider() {
  return createKnownAcpProvider("devin");
}

export function createHermesProvider() {
  return createKnownAcpProvider("hermes");
}

export function createKimiProvider() {
  return createKnownAcpProvider("kimi");
}

export function createKiroProvider() {
  return createKnownAcpProvider("kiro");
}

export function createKiloProvider() {
  return createKnownAcpProvider("kilo");
}

export function createMistralVibeProvider() {
  return createKnownAcpProvider("vibe");
}

export function createCursorProvider() {
  return createKnownAcpProvider("cursor");
}

export function createGeminiProvider() {
  return createKnownAcpProvider("gemini");
}

export function createOpenCodeProvider() {
  return createKnownAcpProvider("opencode");
}

export function createQoderProvider() {
  return createKnownAcpProvider("qoder");
}

export function createQwenProvider() {
  return createKnownAcpProvider("qwen");
}

export function createDefaultLocalAgentProviderPlugins(): LocalAgentProviderPlugin<
  "local-agent",
  string
>[] {
  return [
    createCodexProvider(),
    createClaudeProvider(),
    createTuttiAgentProvider(),
    createHermesProvider(),
    createKimiProvider(),
    createOpenCodeProvider(),
    createCursorProvider(),
  ];
}

export const devinProvider = createDevinProvider();
export const hermesProvider = createHermesProvider();
export const kimiProvider = createKimiProvider();
export const kiroProvider = createKiroProvider();
export const kiloProvider = createKiloProvider();
export const mistralVibeProvider = createMistralVibeProvider();
export const cursorProvider = createCursorProvider();
export const geminiProvider = createGeminiProvider();
export const openCodeProvider = createOpenCodeProvider();
export const qoderProvider = createQoderProvider();
export const qwenProvider = createQwenProvider();
