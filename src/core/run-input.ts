import type { LocalAgentMcpServerConfig } from "./mcp.js";
import type { AgentRunMessage } from "./provider-plugin.js";
import type { AgentPermissionSelection } from "./permissions.js";
import type { SkillMaterializationRecord } from "./skills.js";

export type AgentRunInput<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  /** Exact Tutti Agent Target selected from runtime.detect(). */
  agentTargetId?: string;
  runId: string;
  sessionId?: string;
  conversationId?: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  provider: TProvider;
  runtimeKind?: TKind;
  runtimeProvider?: TProvider;
  history?: AgentRunMessage[];
  mcpServers?: LocalAgentMcpServerConfig[];
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  skillManifest?: SkillMaterializationRecord[];
  reasoning?: string;
  permission?: AgentPermissionSelection;
  extraAllowedDirs?: string[];
  /**
   * Codex-only. When `false`, do not write `.agent-acp-kit-codex-root` into `cwd`
   * and set Codex `project_root_markers = []` so `cwd` is treated as the project root
   * without a user-visible marker file. Default: `true`.
   */
  writeCodexProjectRootMarker?: boolean;
  metadata?: Record<string, unknown>;
  resume?: {
    mode: "native" | "provider" | "fresh";
    providerSessionId?: string;
    resumeToken?: string;
  };
};
