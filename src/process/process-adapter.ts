import { resolveCommandExecutableSync } from "./command-resolver.js";
import {
  isWindowsBatchShim,
  resolveWindowsBatchCommand,
} from "./windows-batch.js";

export type ProcessInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

/** Resolves one shell-free process invocation across supported platforms. */
export function resolveProcessInvocation(input: {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  fallbackCommands?: string[];
  overridePath?: string;
  platform?: NodeJS.Platform;
}): ProcessInvocation {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  let command: string;
  try {
    command = resolveCommandExecutableSync({
      command: input.command,
      env,
      ...(input.fallbackCommands
        ? { fallbackCommands: input.fallbackCommands }
        : {}),
      ...(input.overridePath ? { overridePath: input.overridePath } : {}),
      platform,
    });
  } catch (error) {
    if (!input.overridePath && isWindowsBatchShim(input.command, platform)) {
      throw new Error(`Unsupported Windows batch shim: ${input.command}`);
    }
    throw error;
  }
  if (isWindowsBatchShim(command, platform)) {
    const batch = resolveWindowsBatchCommand(
      command,
      input.args,
      platform,
      {
        env,
      },
    );
    if (!batch) {
      throw new Error(`Unsupported Windows batch shim: ${command}`);
    }
    return {
      command: batch.command,
      args: batch.args,
      env: batch.env ? { ...env, ...batch.env } : env,
    };
  }
  const batch = resolveWindowsBatchCommand(command, input.args, platform, {
    env,
  });
  return {
    command: batch?.command ?? command,
    args: batch?.args ?? [...input.args],
    env: batch?.env ? { ...env, ...batch.env } : env,
  };
}
