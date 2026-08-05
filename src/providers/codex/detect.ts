import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import type { AgentModelOption } from "../../core/provider-plugin.js";
import { redactSecrets } from "../../core/redaction.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { resolveProcessInvocation } from "../../process/process-adapter.js";

function batchExecFileAsync(
  executablePath: string,
  args: string[],
  options: Parameters<typeof execFileAsync>[2] = {},
) {
  const invocation = resolveProcessInvocation({
    command: executablePath,
    args,
    env: options?.env as NodeJS.ProcessEnv | undefined,
    overridePath: executablePath,
  });
  return execFileAsync(invocation.command, invocation.args, {
    ...options,
    encoding: "utf8",
    env: invocation.env,
  });
}

const execFileAsync = promisify(execFile);
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const CODEX_AUTH_STATUS_TIMEOUT_MS = 5_000;
const CODEX_MODEL_DISCOVERY_MAX_BUFFER = 8 * 1024 * 1024;
const CODEX_DEFAULT_MODELS: AgentModelOption[] = [
  { id: "default", label: "Default (CLI config)" },
];

function authStatusText(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  return [record.stdout, record.stderr, record.message]
    .filter((item): item is string => typeof item === "string")
    .join("\n");
}

async function detectCodexAuthState(options: {
  authStatusTimeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
}) {
  try {
    const result = await batchExecFileAsync(
      options.executablePath,
      ["login", "status"],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        timeout: options.authStatusTimeoutMs ?? CODEX_AUTH_STATUS_TIMEOUT_MS,
      },
    );
    const text = authStatusText(result).toLowerCase();
    if (text.includes("not logged in") || text.includes("logged out")) {
      return "missing" as const;
    }
    return text.includes("logged in") ? ("ok" as const) : ("unknown" as const);
  } catch (error) {
    const text = authStatusText(error).toLowerCase();
    if (text.includes("not logged in") || text.includes("logged out")) {
      return "missing" as const;
    }
    return "unknown" as const;
  }
}

function parseSemver(version: string) {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function isVersionAtLeast(version: string, minimumVersion?: string) {
  if (!minimumVersion) {
    return true;
  }
  const current = parseSemver(version);
  const minimum = parseSemver(minimumVersion);
  if (!current || !minimum) {
    return true;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }
  return true;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSupersededCodexModel(
  record: Record<string, unknown>,
  upgradedModelIds: Set<string>,
) {
  const upgrade = getString(record, "upgrade");
  return Boolean(upgrade && upgradedModelIds.has(upgrade));
}

function normalizeCodexCatalog(payload: unknown): AgentModelOption[] {
  const payloadRecord = toRecord(payload);
  const rawModels = Array.isArray(payloadRecord?.data)
    ? payloadRecord.data
    : Array.isArray(payloadRecord?.models)
      ? payloadRecord.models
      : [];
  const seen = new Set<string>();
  const models: AgentModelOption[] = [
    { id: "default", label: "Default (CLI config)" },
  ];
  seen.add("default");
  const records = rawModels
    .map((entry) => toRecord(entry))
    .filter((record): record is Record<string, unknown> => Boolean(record));
  const upgradedModelIds = new Set<string>();
  for (const record of records) {
    const id =
      getString(record, "id") ??
      getString(record, "model") ??
      getString(record, "slug");
    if (id && getString(record, "upgrade")) {
      upgradedModelIds.add(id);
    }
  }
  const upgradeModels: AgentModelOption[] = [];

  function appendModel(id: string, label: string, description?: string) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    models.push({
      id,
      label: label || id,
      ...(description ? { description } : {}),
    });
  }

  for (const record of records) {
    if (record.hidden === true || record.visibility === "hide") continue;
    if (isSupersededCodexModel(record, upgradedModelIds)) continue;

    const id =
      getString(record, "id") ??
      getString(record, "model") ??
      getString(record, "slug");
    if (!id) continue;
    const label =
      getString(record, "displayName") ??
      getString(record, "display_name") ??
      id;
    appendModel(id, label, getString(record, "description"));

    const upgrade = getString(record, "upgrade");
    const upgradeInfo = toRecord(record.upgradeInfo);
    const upgradeLabel =
      (upgradeInfo ? getString(upgradeInfo, "model") : undefined) ?? upgrade;
    if (upgrade && upgradeLabel) {
      upgradeModels.push({ id: upgrade, label: upgradeLabel });
    }
  }

  for (const upgradeModel of upgradeModels) {
    appendModel(upgradeModel.id, upgradeModel.label);
  }

  return models;
}

async function loadCodexAppServerModelCatalog(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
) {
  const invocation = resolveProcessInvocation({
    command: executablePath,
    args: ["app-server"],
    env,
    overridePath: executablePath,
  });
  const child = spawn(invocation.command, invocation.args, {
    ...(cwd ? { cwd } : {}),
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(value: unknown): void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 1;

  function rejectPending(error: Error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function request(method: string, params: unknown) {
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, CODEX_MODEL_DISCOVERY_TIMEOUT_MS);
      pending.set(id, { reject, resolve, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        },
      );
    });
  }

  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    const error = toRecord(message.error);
    if (error) {
      waiter.reject(
        new Error(
          getString(error, "message") ??
            `Codex app-server request ${id} failed.`,
        ),
      );
      return;
    }
    waiter.resolve(message.result);
  });
  child.on("error", (error) => {
    rejectPending(error);
  });
  child.stdin.on("error", (error) => {
    rejectPending(error);
  });
  child.on("close", (code, signal) => {
    rejectPending(
      new Error(
        `Codex app-server exited before model discovery completed: ${
          signal ? `signal ${signal}` : `code ${code ?? 1}`
        }.`,
      ),
    );
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "agent_acp_kit",
        title: "Agent ACP Kit",
        version: "0",
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    return normalizeCodexCatalog(
      await request("model/list", { includeHidden: false }),
    );
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
    }
    pending.clear();
    rl.close();
    if (!child.killed) {
      child.kill();
    }
  }
}

async function loadCodexDebugModelCatalog(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
) {
  const { stdout } = await batchExecFileAsync(
    executablePath,
    ["debug", "models"],
    {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      maxBuffer: CODEX_MODEL_DISCOVERY_MAX_BUFFER,
      timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
    },
  );
  return normalizeCodexCatalog(JSON.parse(stdout) as unknown);
}

export async function discoverCodexModels(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath: string;
}) {
  try {
    return await loadCodexAppServerModelCatalog(
      options.executablePath,
      options.env,
      options.cwd,
    );
  } catch {
    try {
      return await loadCodexDebugModelCatalog(
        options.executablePath,
        options.env,
        options.cwd,
      );
    } catch {
      return CODEX_DEFAULT_MODELS;
    }
  }
}

export async function detectCodex(options?: {
  authStatusTimeoutMs?: number;
  command?: string;
  cwd?: string;
  defaultHomeDirName?: string;
  env?: NodeJS.ProcessEnv;
  homeEnvKey?: string;
  minimumVersion?: string;
  overridePath?: string;
  probeAuthStatus?: boolean;
  redactionSecrets?: readonly string[];
}) {
  const command = options?.command ?? "codex";
  const homeEnvKey = options?.homeEnvKey ?? "CODEX_HOME";
  const environment = options?.env ?? process.env;
  const configDir =
    (environment[homeEnvKey] ?? "").trim() ||
    path.join(homedir(), options?.defaultHomeDirName ?? ".codex");
  let executablePath: string;
  try {
    executablePath = await resolveCommandExecutable({
      command,
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.overridePath ? { overridePath: options.overridePath } : {}),
    });
  } catch (error) {
    return {
      authState: "missing" as const,
      configDir,
      executablePath: command,
      models: CODEX_DEFAULT_MODELS,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? error.message
          : `Executable not found: ${command}`,
      version: "not-installed",
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await batchExecFileAsync(executablePath, ["--version"], {
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      env: options?.env,
    }));
  } catch (error) {
    return {
      authState: "unknown" as const,
      configDir,
      executablePath,
      models: CODEX_DEFAULT_MODELS,
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
  const version = stdout.trim() || "unknown";
  const supported = isVersionAtLeast(version, options?.minimumVersion);
  const authState = options?.probeAuthStatus
    ? await detectCodexAuthState({
        ...(options.authStatusTimeoutMs !== undefined
          ? { authStatusTimeoutMs: options.authStatusTimeoutMs }
          : {}),
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: options.env } : {}),
        executablePath,
      })
    : ("unknown" as const);
  const models =
    authState === "missing"
      ? CODEX_DEFAULT_MODELS
      : await discoverCodexModels({
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          ...(options?.env ? { env: options.env } : {}),
          executablePath,
        });
  return {
    authState,
    configDir,
    executablePath,
    models,
    skillsDir: path.join(configDir, "skills"),
    supported,
    ...(options?.minimumVersion
      ? { minimumVersion: options.minimumVersion }
      : {}),
    ...(supported
      ? {}
      : {
          unsupportedReason: `Codex ${version} is older than the required ${options?.minimumVersion}`,
        }),
    version,
  };
}
