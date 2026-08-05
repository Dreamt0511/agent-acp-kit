import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { resolveProcessInvocation } from "./process-adapter.js";

// System proxy injection.
//
// The standalone ACP agents we spawn (e.g. `claude`) only honor the
// HTTP(S)_PROXY environment variables — they do NOT read the macOS system proxy.
// The Claude desktop app works around this by resolving the OS proxy via
// Electron's session.resolveProxy() (Chromium/SystemConfiguration) and injecting
// HTTPS_PROXY/HTTP_PROXY into the spawned process. Without it, a child agent
// connects directly and, from a restricted region, gets `403 Request not
// allowed` from the upstream API while the app keeps working.
//
// We mirror that behavior here by reading the same SystemConfiguration data via
// `scutil --proxy` and injecting equivalent env vars. To stay faithful to the
// app we: skip SOCKS entries (downstream HTTP agents don't speak SOCKS), use the
// same default NO_PROXY, and never override a proxy the user/session already set.

const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const;
const NPM_PREFIX_TIMEOUT_MS = 2_000;
const LOCAL_AGENT_NESTED_SESSION_ENV_KEYS = ["CLAUDECODE"] as const;

// noProxyDefault matches the value the Claude desktop app injects.
const noProxyDefault = "localhost,127.0.0.1,::1,.local";

// ScutilProxyReader returns the raw output of `scutil --proxy`, or undefined when
// it is unavailable (non-macOS, or the command failing/timing out). It is
// injectable for tests; the default reads the macOS system proxy and is a no-op
// on other platforms.
export type ScutilProxyReader = () => string | undefined;

export function mergeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
  readScutilProxy: ScutilProxyReader = runScutilProxy,
): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
    ...(overrides ?? {}),
  };
  setPathEnv(
    env,
    appendUniquePathDirs(getPathEnv(env), localAgentPathCandidates(env)),
  );
  return injectSystemProxyEnv(env, readScutilProxy);
}

function getPathEnvKey(env: NodeJS.ProcessEnv) {
  if (Object.prototype.hasOwnProperty.call(env, "PATH")) {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function getPathEnv(env: NodeJS.ProcessEnv) {
  return env[getPathEnvKey(env)];
}

function setPathEnv(env: NodeJS.ProcessEnv, value: string) {
  const pathKey = getPathEnvKey(env);
  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toUpperCase() === "PATH") {
      delete env[key];
    }
  }
  env[pathKey] = value;
}

function deleteEnvKeysCaseInsensitive(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
) {
  const targets = new Set(keys.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (targets.has(key.toUpperCase())) {
      delete env[key];
    }
  }
}

/**
 * Standard Windows locations that may hold globally installed CLI shims
 * (npm/pnpm/yarn). These are derived from the home directory instead of
 * inherited env vars because host PATH propagation (e.g. through MSYS bash)
 * can drop APPDATA/LOCALAPPDATA and the npm prefix variables entirely.
 */
function npmGlobalCandidateDirs(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  return [
    // npm's default global bin directory.
    path.join(home, "AppData", "Roaming", "npm"),
    // pnpm's global bin directory.
    path.join(home, "AppData", "Local", "pnpm"),
    // Explicit prefixes from env survive on most setups; keep honoring them.
    env.PNPM_HOME ?? "",
    env.APPDATA ? path.join(env.APPDATA, "npm") : "",
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "pnpm") : "",
    env.npm_config_prefix ?? "",
    env.NPM_CONFIG_PREFIX ?? "",
  ].filter(Boolean);
}

function localAgentPathCandidates(env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") {
    return npmGlobalCandidateDirs(env);
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(homedir(), ".local", "bin"),
    env.npm_config_prefix ? path.join(env.npm_config_prefix, "bin") : "",
    env.NPM_CONFIG_PREFIX ? path.join(env.NPM_CONFIG_PREFIX, "bin") : "",
  ].filter(Boolean);
}

/**
 * Reads a `prefix=` line from the user-level npmrc, honoring an explicit
 * npm global prefix configured with `npm config set prefix`.
 */
async function resolveNpmrcGlobalPrefix(): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(homedir(), ".npmrc"), "utf8");
    const match = content.match(/^\s*prefix\s*=\s*([^\s#][^\r\n]*)$/m);
    const prefix = match?.[1]?.trim();
    return prefix || undefined;
  } catch {
    return undefined;
  }
}

export function appendUniquePathDirs(
  currentPath: string | undefined,
  dirs: string[],
): string {
  const seen = new Set<string>();
  const nextDirs: string[] = [];
  for (const dir of [...(currentPath ?? "").split(path.delimiter), ...dirs]) {
    const normalized = dir.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    nextDirs.push(normalized);
  }
  return nextDirs.join(path.delimiter);
}

function npmGlobalBinFromPrefix(prefix: string) {
  return platform() === "win32" ? prefix : path.join(prefix, "bin");
}

async function runNpmPrefixCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let invocation;
    try {
      invocation = resolveProcessInvocation({
        command,
        args: ["prefix", "-g"],
        env,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      finish(undefined);
    }, NPM_PREFIX_TIMEOUT_MS);

    function finish(prefix: string | undefined) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(prefix);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => {
      const prefix = stdout.trim().split("\n")[0]?.trim();
      finish(code === 0 && prefix ? prefix : undefined);
    });
  });
}

async function resolveNpmGlobalPrefix(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  // 1. `npm` on the inherited PATH (may be missing when host PATH
  //    propagation dropped the npm global directory).
  const onPath = await runNpmPrefixCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    env,
  );
  if (onPath) return onPath;

  // 2. npm.cmd at the standard global locations, reached without PATH.
  if (process.platform === "win32") {
    for (const dir of npmGlobalCandidateDirs(env)) {
      const npmCmd = path.join(dir, "npm.cmd");
      if (existsSync(npmCmd)) {
        const prefix = await runNpmPrefixCommand(npmCmd, env);
        if (prefix) return prefix;
      }
    }
  }

  // 3. Explicit prefix configured in the user-level npmrc.
  return await resolveNpmrcGlobalPrefix();
}

export async function buildLocalAgentProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const env = mergeProcessEnv(baseEnv);
  deleteEnvKeysCaseInsensitive(env, LOCAL_AGENT_NESTED_SESSION_ENV_KEYS);

  const npmPrefix = await resolveNpmGlobalPrefix(env);
  if (npmPrefix) {
    setPathEnv(
      env,
      appendUniquePathDirs(getPathEnv(env), [
        npmGlobalBinFromPrefix(npmPrefix),
      ]),
    );
  }

  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

// injectSystemProxyEnv adds HTTPS_PROXY/HTTP_PROXY/NO_PROXY derived from the
// macOS system proxy, but only for keys not already present (case-insensitive)
// in env, so explicit user/session settings always win.
export function injectSystemProxyEnv(
  env: NodeJS.ProcessEnv,
  readScutilProxy: ScutilProxyReader = runScutilProxy,
): NodeJS.ProcessEnv {
  const proxyEnv = systemProxyEnv(readScutilProxy);
  if (!proxyEnv) {
    return env;
  }
  const present = new Set(
    Object.keys(env)
      .filter((key) => env[key] !== undefined)
      .map((key) => key.toUpperCase()),
  );
  const result = { ...env };
  for (const key of PROXY_KEYS) {
    const value = proxyEnv[key];
    if (!value || value.trim() === "") {
      continue;
    }
    if (present.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function systemProxyEnv(
  readScutilProxy: ScutilProxyReader,
): Record<string, string> | undefined {
  const output = readScutilProxy();
  if (output === undefined) {
    return undefined;
  }
  return parseScutilProxy(output);
}

// runScutilProxy reads the macOS system proxy configuration. The result is
// memoized for the lifetime of the process: the system proxy is static (the same
// assumption the Claude desktop app makes), and this keeps the blocking exec off
// the hot path when many short-lived agents are spawned in sequence. It is a
// no-op on non-macOS platforms, where proxies are conventionally driven by env
// vars.
let cachedScutilProxy: { value: string | undefined } | undefined;

function runScutilProxy(): string | undefined {
  if (!cachedScutilProxy) {
    cachedScutilProxy = { value: readScutilProxyUncached() };
  }
  return cachedScutilProxy.value;
}

function readScutilProxyUncached(): string | undefined {
  if (platform() !== "darwin") {
    return undefined;
  }
  try {
    return execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return undefined;
  }
}

// parseScutilProxy turns `scutil --proxy` output into proxy env vars.
//
// Example input:
//
//   <dictionary> {
//     HTTPSEnable : 1
//     HTTPSProxy : 127.0.0.1
//     HTTPSPort : 7890
//     ...
//   }
//
// SOCKS entries are intentionally ignored, and PAC (ProxyAutoConfig) is not
// resolved — scutil only exposes the PAC URL, not the per-URL result, so we
// leave those to the user's explicit env. Returns undefined when no usable proxy
// is configured (direct connection).
export function parseScutilProxy(
  output: string,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const proxyUrl = (enableKey: string, hostKey: string, portKey: string) => {
    if (fields[enableKey] !== "1") {
      return undefined;
    }
    const host = fields[hostKey];
    const port = fields[portKey];
    if (!host || !port) {
      return undefined;
    }
    return `http://${joinHostPort(host, port)}`;
  };

  // Prefer the HTTPS entry (the upstream API is HTTPS); fall back to HTTP. Both
  // env vars point at the same proxy, mirroring the Claude app.
  const url =
    proxyUrl("HTTPSEnable", "HTTPSProxy", "HTTPSPort") ??
    proxyUrl("HTTPEnable", "HTTPProxy", "HTTPPort");
  if (!url) {
    return undefined;
  }

  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxyDefault,
  };
}

// joinHostPort mirrors Go's net.JoinHostPort: bracket IPv6 literals (which
// contain ":") so the host:port is unambiguous.
function joinHostPort(host: string, port: string): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function resolveTempDir(env?: Record<string, string | undefined>) {
  return (
    env?.TMPDIR?.trim() ||
    env?.TEMP?.trim() ||
    env?.TMP?.trim() ||
    process.env.TMPDIR?.trim() ||
    process.env.TEMP?.trim() ||
    process.env.TMP?.trim() ||
    tmpdir()
  );
}
