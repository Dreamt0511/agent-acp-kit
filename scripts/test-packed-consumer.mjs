import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(path.join(tmpdir(), "agent-acp-kit-consumer-"));

try {
  const npm = resolveNpmInvocation();
  const packOutput = execFileSync(
    npm.command,
    [...npm.prefixArgs, "pack", "--json", "--pack-destination", fixture],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const packResult = JSON.parse(packOutput)[0];
  const tarball = path.join(fixture, packResult.filename);
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "agent-acp-kit-consumer",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    npm.command,
    [
      ...npm.prefixArgs,
      "install",
      "--ignore-scripts",
      tarball,
      "typescript@5.9.3",
      "@types/node@22.19.19",
    ],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  writeFileSync(
    path.join(fixture, "type-smoke.ts"),
    `
import type { AgentRunInput, DetectedProvider } from "@tutti-os/agent-acp-kit";
import type { TuttiAgentPermissionMode } from "@tutti-os/agent-acp-kit/tutti/contracts";

export function composerPermissionToRun(
  mode: TuttiAgentPermissionMode,
): AgentRunInput["permission"] {
  return { modeId: mode.id, semantic: mode.semantic };
}
export function selectable(provider: DetectedProvider): boolean {
  return provider.supported && provider.authState === "ok";
}
`,
  );
  execFileSync(
    process.execPath,
    [
      path.join(fixture, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "type-smoke.ts",
    ],
    { cwd: fixture, stdio: "inherit" },
  );
  writeFileSync(
    path.join(fixture, "smoke.mjs"),
    `
import {
  createGenericAcpProvider,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";
import {
  loadTuttiAgentCatalog,
  loadTuttiAgentSkillContext,
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "@tutti-os/agent-acp-kit/tutti";
import { isTuttiAgentCatalog } from "@tutti-os/agent-acp-kit/tutti/contracts";
import { resolveProcessInvocation } from "@tutti-os/agent-acp-kit/process-adapter";
import { createFakeAcpPeerScript } from "@tutti-os/agent-acp-kit/testing";

const peer = createFakeAcpPeerScript({
  updates: [{ sessionUpdate: "text_delta", content: { text: "packed-ok" } }],
});
const directInvocation = resolveProcessInvocation({
  command: process.execPath,
  args: ["--version"],
});
if (directInvocation.command !== process.execPath) {
  throw new Error("packed process adapter failed");
}
const packedProvider = createGenericAcpProvider({
  providerId: "packed",
  displayName: "Packed",
  command: process.execPath,
  args: ["-e", peer],
});
const runtime = createLocalAgentRuntime({
  providers: [{
    ...packedProvider,
    detect: async () => ({
      authState: "ok",
      executablePath: process.execPath,
      supported: true,
      version: process.version,
    }),
  }],
});
const vmEnv = {
  CODEX_HOME: "/home/tsh-runtime/.codex",
  TMPDIR: "/workspace/.tsh/apps/runtimes/runtime-1/tmp",
};
const detectContext = {
  cwd: process.cwd(),
  env: vmEnv,
  redactionSecrets: ["packed-existing"],
};
const projection = projectTuttiCliChildProcess({
  baseEnv: vmEnv,
  detectContext,
});
if (projection.env.CODEX_HOME !== "/home/tsh-runtime/.codex") {
  throw new Error("VM source CODEX_HOME projection failed");
}
if (!Object.isFrozen(projection.env) || !projection.redactionSecrets.includes("packed-existing")) {
  throw new Error("projection immutability/redaction failed");
}
if (redactTuttiCliChildProcessText("value=packed-existing", projection.redactionSecrets) !== "value=[REDACTED]") {
  throw new Error("packed redaction helper failed");
}
const catalog = await loadTuttiAgentCatalog({
  detectContext,
  env: vmEnv,
  runtime,
  runTuttiCli: async (_args, options) => {
    if (options.env.CODEX_HOME !== "/home/tsh-runtime/.codex") {
      throw new Error("packed facade lost VM source CODEX_HOME");
    }
    return ({
    schemaVersion: 1,
    defaultAgentTargetId: "local:packed",
    agents: [{
      id: "local:packed",
      name: "Packed",
      provider: "packed",
      availability: { status: "available", reasonCode: "", detail: "" },
    }],
    });
  },
});
if (!isTuttiAgentCatalog(catalog)) throw new Error("catalog contract failed");
const detected = await runtime.detect();
if (detected[0]?.provider !== "packed" || detected[0]?.supported !== true || "result" in detected[0]) {
  throw new Error("flat runtime detection contract failed");
}
const standaloneSkills = await loadTuttiAgentSkillContext({
  env: {},
  agentTargetId: "local:packed",
});
if (standaloneSkills.source !== "standalone") throw new Error("skill auto fallback failed");
const events = [];
for await (const event of runtime.run({
  runId: "packed-run",
  provider: "packed",
  cwd: process.cwd(),
  prompt: "hello",
})) events.push(event);
if (!events.some((event) => event.type === "text_delta" && event.text === "packed-ok")) {
  throw new Error("packed ACP runtime failed");
}
console.log(JSON.stringify({ ok: true, agents: catalog.agents.length, events: events.length }));
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: fixture,
    stdio: "inherit",
  });
  const packageJson = JSON.parse(
    readFileSync(
      path.join(fixture, "node_modules/@tutti-os/agent-acp-kit/package.json"),
      "utf8",
    ),
  );
  console.log(
    `packed consumer verified @tutti-os/agent-acp-kit@${packageJson.version}`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

function resolveNpmInvocation() {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }
  const cli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(cli)) {
    throw new Error(`npm CLI was not found beside Node.js: ${cli}`);
  }
  return { command: process.execPath, prefixArgs: [cli] };
}
