import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, normalize } from "node:path";

import { resolveCommandExecutableSync } from "./command-resolver.js";

/**
 * A shell-free Windows command launch plan.
 *
 * Node cannot execute `.cmd`/`.bat` files directly. Passing arbitrary agent
 * arguments through `cmd.exe /c` is unsafe because cmd reparses metacharacters.
 * This adapter resolves direct executable shims, npm/node shims, and PowerShell
 * `-File` shims to shell-free launch plans. Unknown batch files fail closed.
 * Non-Windows callers receive `null`.
 */
export type WindowsBatchResolved = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  windowsVerbatimArguments?: boolean;
};

export function isWindowsBatchShim(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command.trim());
}

export function resolveWindowsBatchCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  options: { env?: NodeJS.ProcessEnv } = {},
): WindowsBatchResolved | null {
  if (platform !== "win32") return null;

  const trimmed = command.trim();
  if (/\.[a-z0-9]+$/i.test(trimmed) && !isWindowsBatchShim(trimmed, platform)) {
    return null;
  }
  let executable = trimmed;
  if (!isWindowsBatchShim(trimmed, platform)) {
    try {
      executable = resolveCommandExecutableSync({
        command: trimmed,
        env: options.env,
      });
    } catch {
      if (!isWindowsBatchShim(trimmed, platform)) return null;
    }
  }

  if (!isWindowsBatchShim(executable, platform)) {
    return executable === trimmed
      ? null
      : { command: executable, args: [...args] };
  }

  const target = resolveBatchShimTarget(executable, options.env ?? process.env);
  if (!target) {
    throw new Error(`Unsupported Windows batch shim: ${executable}`);
  }
  return {
    command: target.command,
    args: [...target.prefixArgs, ...args],
    env: extractBatchShimEnv(
      target.content,
      executable,
      options.env ?? process.env,
    ),
  };
}

function resolveBatchShimTarget(
  shimPath: string,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[]; content: string } | null {
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const shimDir = dirname(shimPath);

  for (const line of content.split(/\r?\n/)) {
    if (!line.includes("%*")) continue;
    const paths = (line.match(/"([^"]*)"/g) ?? [])
      .map((quoted) => expandShimPath(quoted.slice(1, -1).trim(), shimDir))
      .filter((value): value is string => Boolean(value));
    for (let index = 0; index < paths.length; index += 1) {
      const candidate = paths[index]!;
      if (candidate === "node") {
        return {
          command: process.execPath,
          prefixArgs: paths.slice(index + 1),
          content,
        };
      }
      if (/\.(?:exe|com)$/i.test(candidate) && existsSync(candidate)) {
        return { command: candidate, prefixArgs: paths.slice(index + 1), content };
      }
    }
  }
  const shimEnv = {
    ...baseEnv,
    ...extractBatchShimEnv(content, shimPath, baseEnv),
  };
  for (const line of content.split(/\r?\n/)) {
    const target = resolvePowerShellShimLine(line, shimDir, shimEnv);
    if (target) return { ...target, content };
  }
  return null;
}

function resolvePowerShellShimLine(
  line: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } | null {
  const passthroughIndex = line.indexOf("%*");
  if (passthroughIndex < 0) return null;
  const prefix = line.slice(0, passthroughIndex).trim();
  if (!/powershell\.exe/i.test(prefix) || /[&|<>]/u.test(prefix)) return null;
  const tokens = Array.from(prefix.matchAll(/"([^"]*)"|([^\s"]+)/g), (match) =>
    (match[1] ?? match[2] ?? "").trim(),
  ).filter(Boolean);
  if (tokens.length < 3) return null;

  const commandValue = expandBatchToken(tokens[0]!.replace(/^@/u, ""), shimDir, env);
  if (!commandValue) return null;
  const command = normalize(commandValue);
  if (!/powershell\.exe$/i.test(command) || !existsSync(command)) return null;

  const prefixArgs = tokens.slice(1).map((token) => expandBatchToken(token, shimDir, env));
  if (prefixArgs.some((token) => token === null)) return null;
  const args = prefixArgs as string[];
  if (args.some((arg) => /^-(?:command|encodedcommand|commandwithargs)$/i.test(arg))) {
    return null;
  }
  const fileIndex = args.findIndex((arg) => /^-file$/i.test(arg));
  if (fileIndex < 0 || fileIndex + 1 >= args.length) return null;
  const scriptPath = normalize(args[fileIndex + 1]!);
  if (!/\.ps1$/i.test(scriptPath) || !existsSync(scriptPath)) return null;
  args[fileIndex + 1] = scriptPath;
  return { command, prefixArgs: args };
}

function expandBatchToken(
  token: string,
  shimDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  let unresolved = false;
  const expanded = token
    .replace(/%~?dp0%?/gi, `${shimDir}\\`)
    .replace(/%([^%]+)%/g, (_placeholder, envKey: string) => {
      const value = getEnvValue(env, envKey);
      if (value === undefined) unresolved = true;
      return value ?? "";
    });
  return unresolved || /%[^%]+%/u.test(expanded) ? null : expanded;
}

function extractBatchShimEnv(
  content: string,
  shimPath: string,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const shimDir = dirname(shimPath);
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:if\s+"%[^"]*"\s*==\s*""\s*)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*"?([^\r\n"]*)"?\s*$/i,
    );
    if (!match) continue;
    const key = match[1]!;
    if (/^(?:dp0|_prog|pathext)$/i.test(key)) continue;
    if (/^\s*if\b/i.test(line) && getEnvValue(baseEnv, key) !== undefined) {
      continue;
    }
    const value = (match[2] ?? "")
      .replace(/%~nx0/gi, basename(shimPath))
      .replace(/%~?dp0%?/gi, `${shimDir}\\`)
      .replace(/%([^%]+)%/g, (placeholder, envKey: string) =>
        getEnvValue(baseEnv, envKey) ?? placeholder,
      )
      .trim();
    if (value) env[key] = value;
  }
  return env;
}

function getEnvValue(env: NodeJS.ProcessEnv, key: string) {
  const match = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match ? env[match] : undefined;
}

function expandShimPath(raw: string, shimDir: string): string {
  const dir = shimDir.replace(/[\\/]+$/, "");
  return raw.replace(/%~?dp0%/gi, dir).replace(/%_prog%/gi, "node");
}
