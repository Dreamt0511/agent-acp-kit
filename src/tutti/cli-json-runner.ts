import { execFile } from "node:child_process";

import type { DetectContext } from "../core/detection.js";
import {
  resolveWindowsBatchCommand,
  type WindowsBatchResolved,
} from "../process/windows-batch.js";
import { projectTuttiCliChildProcess, redactTuttiCliChildProcessText } from "./child-process.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type TuttiIntegrationErrorCode =
  | "agent_ambiguous"
  | "agent_not_found"
  | "cli_aborted"
  | "cli_execution_failed"
  | "cli_timeout"
  | "invalid_response"
  | "provider_not_found"
  | "provider_runtime_unavailable"
  | "unsupported_command"
  | "unsupported_schema";

export class TuttiIntegrationError extends Error {
  constructor(
    readonly code: TuttiIntegrationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TuttiIntegrationError";
  }
}

export type TuttiCliJsonRunner = (
  args: string[],
  options: {
    cwd?: string;
    env: Readonly<NodeJS.ProcessEnv>;
    maxBuffer: number;
    redactionSecrets: readonly string[];
    signal?: AbortSignal;
    timeoutMs: number;
  },
) => Promise<unknown>;

export interface ResolveTuttiCliCommandInput {
  env?: Record<string, string | undefined>;
  envNames?: string[];
}

export function resolveTuttiCliCommand(input: ResolveTuttiCliCommandInput = {}): string {
  const env = input.env ?? process.env;
  for (const name of [...(input.envNames ?? []), "TUTTI_CLI"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export interface TuttiCliJsonRequest {
  args: string[];
  command?: string | null;
  commandEnvNames?: string[];
  cwd?: string | null;
  detectContext?: DetectContext;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  runTuttiCli?: TuttiCliJsonRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function resolveTuttiCliRequestEnv(
  input: Pick<TuttiCliJsonRequest, "detectContext" | "env">,
): NodeJS.ProcessEnv | undefined {
  return input.env;
}

export function hasConfiguredTuttiCli(input: Omit<TuttiCliJsonRequest, "args">) {
  const env = resolveTuttiCliRequestEnv(input);
  return Boolean(
    input.runTuttiCli ||
    normalizeOptionalString(input.command) ||
    resolveTuttiCliCommand({ env, envNames: input.commandEnvNames }),
  );
}

/**
 * Resolves how to spawn the Tutti CLI command on Windows.
 *
 * Windows batch shims (for example the `tutti.cmd` / `tutti-dev.cmd` wrappers
 * installed by the Tutti desktop shell) cannot be spawned directly:
 * CreateProcess cannot execute batch files. This resolves the shim's real
 * executable via the shared windows-batch resolver. Unknown batch files fail
 * closed so arbitrary argv is never passed through cmd.exe parsing.
 *
 * All other platforms (macOS/Unix shell-script shims) and non-batch commands
 * return `null`, keeping the direct no-shell execFile path unchanged.
 */
export function resolveTuttiCliBatchExecFile(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): WindowsBatchResolved | null {
  return resolveWindowsBatchCommand(command, args, platform);
}

export async function runTuttiCliJson(input: TuttiCliJsonRequest): Promise<unknown> {
  const cwd = normalizeOptionalString(input.cwd);
  const env = resolveTuttiCliRequestEnv(input);
  const child = projectTuttiCliChildProcess({
    baseEnv: env,
    detectContext: input.detectContext,
  });
  const options = {
    ...(cwd ? { cwd } : {}),
    env: child.env,
    redactionSecrets: child.redactionSecrets,
    maxBuffer: input.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(input.signal ? { signal: input.signal } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  try {
    const payload = input.runTuttiCli
      ? await input.runTuttiCli(input.args, options)
      : await execTuttiCli({
          args: input.args,
          command:
            normalizeOptionalString(input.command) ??
            resolveTuttiCliCommand({
              env,
              envNames: input.commandEnvNames,
            }),
          ...options,
        });
    if (typeof payload !== "string") return payload;
    try {
      return JSON.parse(payload || "{}");
    } catch {
      throw new TuttiIntegrationError("invalid_response", "Tutti CLI returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof TuttiIntegrationError) throw error;
    if (input.signal?.aborted) {
      throw new TuttiIntegrationError("cli_aborted", "Tutti CLI request was aborted.");
    }
    const candidate = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    if (candidate.killed && candidate.signal === "SIGTERM") {
      throw new TuttiIntegrationError("cli_timeout", "Tutti CLI request timed out.");
    }
    throw new TuttiIntegrationError("cli_execution_failed", "Tutti CLI request failed.");
  }
}

async function execTuttiCli(input: {
  args: string[];
  command: string;
  cwd?: string;
  env: Readonly<NodeJS.ProcessEnv>;
  maxBuffer: number;
  redactionSecrets: readonly string[];
  signal?: AbortSignal;
  timeoutMs: number;
}) {
  if (!input.command) {
    throw new TuttiIntegrationError("cli_execution_failed", "Tutti CLI command is not configured.");
  }
  const batchExec = resolveTuttiCliBatchExecFile(input.command, input.args);
  return await new Promise<string>((resolve, reject) => {
    execFile(
      batchExec?.command ?? input.command,
      batchExec?.args ?? input.args,
      {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        encoding: "utf8",
        env: batchExec?.env ? { ...input.env, ...batchExec.env } : input.env,
        maxBuffer: input.maxBuffer,
        ...(input.signal ? { signal: input.signal } : {}),
        timeout: input.timeoutMs,
        // cmd.exe receives the already-quoted command string verbatim; Node's
        // default quoting would double-escape it and cmd would misparse.
        ...(batchExec?.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            toTuttiCliExecutionError(error, stdout, stderr, input.redactionSecrets, input.signal),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function toTuttiCliExecutionError(
  error: {
    code?: string | number | null;
    killed?: boolean;
    signal?: string | null;
  },
  stdout: string,
  stderr: string,
  redactionSecrets: readonly string[],
  signal?: AbortSignal,
) {
  const details: Record<string, string | number | boolean> = {
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
  if (stderr) {
    details.stderr = redactTuttiCliChildProcessText(stderr, redactionSecrets);
  }
  if (signal?.aborted) {
    return new TuttiIntegrationError("cli_aborted", "Tutti CLI request was aborted.", details);
  }
  if (typeof error.code === "number" || typeof error.code === "string") {
    details.exitCode = error.code;
  }
  if (typeof error.signal === "string" && error.signal) {
    details.signal = error.signal;
  }
  if (error.killed && error.signal === "SIGTERM") {
    return new TuttiIntegrationError("cli_timeout", "Tutti CLI request timed out.", details);
  }
  if (isUnsupportedAgentListCommand(details.stderr)) {
    return new TuttiIntegrationError(
      "unsupported_command",
      "Tutti CLI does not support the agent list command.",
      details,
    );
  }
  return new TuttiIntegrationError("cli_execution_failed", "Tutti CLI request failed.", details);
}

function isUnsupportedAgentListCommand(stderr: unknown) {
  return (
    typeof stderr === "string" && /(?:^|\n)unknown command:\s+agent list\s*(?:\n|$)/u.test(stderr)
  );
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
