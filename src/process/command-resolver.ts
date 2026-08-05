import { access } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

async function isExecutable(filePath: string) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableSync(filePath: string) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getCandidates(input: {
  command: string;
  fallbackCommands?: string[];
}) {
  return [input.command, ...(input.fallbackCommands ?? [])];
}

function getEnvValue(env: NodeJS.ProcessEnv | undefined, key: string) {
  if (!env) return undefined;
  const match = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match ? env[match] : undefined;
}

function getSearchPath(
  env: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  const inherited = getEnvValue(env, "PATH") ?? process.env.PATH ?? "";
  if (platform !== "win32") return inherited;

  const appData = getEnvValue(env, "APPDATA");
  const localAppData = getEnvValue(env, "LOCALAPPDATA");
  const npmPrefix =
    getEnvValue(env, "npm_config_prefix") ??
    getEnvValue(env, "NPM_CONFIG_PREFIX");
  const dirs = [
    ...inherited.split(delimiter),
    getEnvValue(env, "PNPM_HOME"),
    npmPrefix,
    appData ? join(appData, "npm") : undefined,
    localAppData ? join(localAppData, "pnpm") : undefined,
  ].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  return dirs
    .filter((dir) => {
      const normalized = dir.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(delimiter);
}

/**
 * Windows resolves extension-less command names through PATHEXT
 * (`.exe`, `.cmd`, `.bat`, ...). Node's spawn/execFile do not, so resolve the
 * concrete shim path here; callers resolve supported `.cmd`/`.bat` shims to
 * their real executable without invoking a shell.
 * Non-Windows hosts return the command unchanged.
 */
function withWindowsExecutableExtensions(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env?: NodeJS.ProcessEnv,
) {
  if (platform !== "win32") {
    return [command];
  }
  if (/\.[a-z0-9]+$/i.test(command)) {
    return [command];
  }
  const supported = new Set([".com", ".exe", ".cmd", ".bat"]);
  const configured = (getEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => supported.has(extension));
  const extensions = [...new Set([...configured, ...supported])];
  // The bare name comes last because npm also installs extension-less POSIX
  // shell scripts that CreateProcess cannot execute.
  return [...extensions.map((extension) => `${command}${extension}`), command];
}

export async function resolveCommandExecutable(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  fallbackCommands?: string[];
  overridePath?: string;
  platform?: NodeJS.Platform;
}) {
  if (input.overridePath) {
    return input.overridePath;
  }

  const commands = getCandidates(input);
  const platform = input.platform ?? process.platform;
  for (const command of commands) {
    if (isAbsolute(command)) {
      for (const candidate of withWindowsExecutableExtensions(
        command,
        platform,
        input.env,
      )) {
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    const pathValue = getSearchPath(input.env, platform);
    for (const part of pathValue.split(delimiter).filter(Boolean)) {
      for (const candidate of withWindowsExecutableExtensions(
        join(part, command),
        platform,
        input.env,
      )) {
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }

  throw new Error(`Executable not found on PATH: ${commands.join(", ")}`);
}

export function resolveCommandExecutableSync(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  fallbackCommands?: string[];
  overridePath?: string;
  platform?: NodeJS.Platform;
}) {
  if (input.overridePath) {
    return input.overridePath;
  }

  const commands = getCandidates(input);
  const platform = input.platform ?? process.platform;
  for (const command of commands) {
    if (isAbsolute(command)) {
      for (const candidate of withWindowsExecutableExtensions(
        command,
        platform,
        input.env,
      )) {
        if (isExecutableSync(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    const pathValue = getSearchPath(input.env, platform);
    for (const part of pathValue.split(delimiter).filter(Boolean)) {
      for (const candidate of withWindowsExecutableExtensions(
        join(part, command),
        platform,
        input.env,
      )) {
        if (isExecutableSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  throw new Error(`Executable not found on PATH: ${commands.join(", ")}`);
}
