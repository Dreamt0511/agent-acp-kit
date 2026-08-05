import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { attachAbortSignal, terminateProcessTree } from "./cancellation.js";
import { mergeProcessEnv } from "./env.js";
import { resolveProcessInvocation } from "./process-adapter.js";
import { StderrBuffer } from "./stderr-buffer.js";

export type SupervisedProcess = {
  child: ChildProcessWithoutNullStreams;
  stderr: StderrBuffer;
  waitForExit(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>;
};

export function spawnSupervisedProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  fallbackCommands?: string[];
  keepStdinOpen?: boolean;
  killAfterMs?: number;
  overridePath?: string;
  prompt?: string;
  promptInput?: "stdin" | "argv";
  redactionSecrets?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const env = mergeProcessEnv(process.env, input.env);
  const stderr = new StderrBuffer(
    16_000,
    [
      ...Object.values(input.env ?? {}),
      ...(input.redactionSecrets ?? []),
    ].filter(Boolean),
  );
  const invocation = resolveProcessInvocation({
    command: input.command,
    args: input.args,
    env,
    ...(input.fallbackCommands
      ? { fallbackCommands: input.fallbackCommands }
      : {}),
    ...(input.overridePath ? { overridePath: input.overridePath } : {}),
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: input.cwd,
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killFallback: NodeJS.Timeout | undefined;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.append(chunk));

  const detachAbort = attachAbortSignal(
    child,
    input.signal,
    input.killAfterMs ? { killAfterMs: input.killAfterMs } : undefined,
  );
  if (input.timeoutMs && input.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        terminateProcessTree(child, "SIGTERM");
      }
      killFallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateProcessTree(child, "SIGKILL");
        }
      }, input.killAfterMs ?? 2_000);
    }, input.timeoutMs);
  }

  function cleanup() {
    detachAbort();
    if (timeout) {
      clearTimeout(timeout);
    }
    if (killFallback) {
      clearTimeout(killFallback);
    }
  }

  if (input.promptInput === "stdin" && input.prompt && !input.keepStdinOpen) {
    child.stdin.write(input.prompt);
  }
  if (!input.keepStdinOpen) {
    child.stdin.end();
  }

  const processHandle: SupervisedProcess = {
    child,
    stderr,
    waitForExit() {
      return new Promise((resolve, reject) => {
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("close", (code, signal) => {
          cleanup();
          resolve({ code, signal, timedOut });
        });
      });
    },
  };

  return processHandle;
}
