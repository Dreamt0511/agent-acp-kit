import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentModelOption } from "../../core/provider-plugin.js";
import { redactSecrets } from "../../core/redaction.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { resolveProcessInvocation } from "../../process/process-adapter.js";

const execFileAsync = promisify(execFile);
const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 8_000;
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 8_000;
const CLAUDE_DEFAULT_MODELS: AgentModelOption[] = [
  { id: "default", label: "Default (CLI config)" },
];

function resolveClaudeConfigDir(env?: NodeJS.ProcessEnv) {
  const configured = env?.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(homedir(), ".claude");
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseClaudeAuthState(stdout: string) {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "unknown" as const;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return "unknown" as const;
  }

  const status = readNonEmptyString(payload.status)?.toLowerCase();
  const message = [payload.error, payload.message, payload.reason]
    .map(readNonEmptyString)
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  const expiresAt = readNonEmptyString(
    payload.expiresAt ?? payload.expires_at ?? payload.expiration,
  );
  const expiryTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;

  if (
    status === "expired" ||
    message.includes("expired") ||
    (Number.isFinite(expiryTime) && expiryTime <= Date.now())
  ) {
    return "expired" as const;
  }
  if (payload.loggedIn === true || payload.authenticated === true) {
    return "ok" as const;
  }
  if (
    payload.loggedIn === false ||
    payload.authenticated === false ||
    status === "missing" ||
    status === "logged_out" ||
    status === "unauthenticated"
  ) {
    return "missing" as const;
  }
  return "unknown" as const;
}

export async function detectClaudeAuthState(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
}) {
  try {
    const invocation = resolveProcessInvocation({
      command: input.executablePath,
      args: ["auth", "status"],
      env: input.env,
      overridePath: input.executablePath,
    });
    const { stdout } = await execFileAsync(
      invocation.command,
      invocation.args,
      {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: invocation.env,
        timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS,
      },
    );
    return parseClaudeAuthState(stdout);
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? (error as { stdout?: unknown }).stdout
        : undefined;
    const parsed = parseClaudeAuthState(
      typeof stdout === "string"
        ? stdout
        : Buffer.isBuffer(stdout)
          ? stdout.toString("utf8")
          : "",
    );
    // A failed status command cannot establish a positive login, but current
    // Claude versions intentionally exit 1 with JSON for missing credentials.
    if (parsed === "missing" || parsed === "expired") return parsed;
    return "unknown" as const;
  }
}

type ClaudeSdkModelInfo = {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
};

async function* idleClaudePrompt(): AsyncIterable<never> {
  await new Promise<void>(() => {
    // Keep streaming input open until the SDK initialization response is read.
  });
}

function normalizeClaudeSdkModels(sdkModels: unknown): AgentModelOption[] {
  const models = Array.isArray(sdkModels) ? sdkModels : [];
  const normalized: AgentModelOption[] = [];
  const seen = new Set<string>();

  function append(model: AgentModelOption) {
    if (!model.id || seen.has(model.id)) return;
    seen.add(model.id);
    normalized.push(model);
  }

  for (const entry of models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as ClaudeSdkModelInfo;
    const id =
      typeof record.value === "string" && record.value.trim()
        ? record.value.trim()
        : undefined;
    if (!id) continue;
    const label =
      typeof record.displayName === "string" && record.displayName.trim()
        ? record.displayName.trim()
        : id;
    const description =
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : undefined;
    append({
      id,
      label,
      ...(description ? { description } : {}),
    });
  }

  if (!seen.has("default")) {
    normalized.unshift(CLAUDE_DEFAULT_MODELS[0]!);
  }

  return normalized.length > 0 ? normalized : CLAUDE_DEFAULT_MODELS;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude SDK model discovery timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function discoverClaudeSdkModels(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
}) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const queryHandle = sdk.query({
    prompt: idleClaudePrompt(),
    options: {
      cwd: input.cwd,
      env: input.env,
      includePartialMessages: true,
      pathToClaudeCodeExecutable: input.executablePath,
      settingSources: ["user", "project", "local"],
    },
  });
  try {
    const models = await withTimeout(
      queryHandle.supportedModels(),
      CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS,
    );
    return normalizeClaudeSdkModels(models);
  } finally {
    queryHandle.close();
  }
}

export async function detectClaude(options?: {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overridePath?: string;
  redactionSecrets?: readonly string[];
}) {
  const command = options?.command ?? "claude";
  const configDir = resolveClaudeConfigDir(options?.env);
  const fallbackModels = CLAUDE_DEFAULT_MODELS;
  let executablePath: string;
  try {
    executablePath = await resolveCommandExecutable({
      command,
      ...(options?.env ? { env: options.env } : {}),
      fallbackCommands: ["openclaude"],
      ...(options?.overridePath ? { overridePath: options.overridePath } : {}),
    });
  } catch (error) {
    return {
      authState: "missing" as const,
      configDir,
      executablePath: command,
      models: fallbackModels,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? error.message
          : "Executable not found on PATH: claude, openclaude",
      version: "not-installed",
    };
  }

  let stdout: string;
  try {
    const invocation = resolveProcessInvocation({
      command: executablePath,
      args: ["--version"],
      env: options?.env,
      overridePath: executablePath,
    });
    ({ stdout } = await execFileAsync(invocation.command, invocation.args, {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      env: invocation.env,
    }));
  } catch (error) {
    return {
      authState: "unknown" as const,
      configDir,
      executablePath,
      models: fallbackModels,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? redactSecrets(
              `Unable to run ${command} --version: ${error.message}`,
              [...(options?.redactionSecrets ?? [])],
            )
          : `Unable to run ${command} --version`,
      version: "unknown",
    };
  }

  const authState = await detectClaudeAuthState({
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.env ? { env: options.env } : {}),
    executablePath,
  });

  let models = fallbackModels;
  if (authState === "ok") {
    try {
      models = await discoverClaudeSdkModels({
        cwd: options?.cwd ?? process.cwd(),
        ...(options?.env ? { env: options.env } : {}),
        executablePath,
      });
    } catch {
      models = fallbackModels;
    }
  }

  return {
    authState,
    configDir,
    executablePath,
    models,
    skillsDir: path.join(configDir, "skills"),
    supported: true,
    version: stdout.trim() || "unknown",
  };
}
