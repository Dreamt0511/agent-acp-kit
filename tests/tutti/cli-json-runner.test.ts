import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasConfiguredTuttiCli,
  resolveTuttiCliInvocation,
  runTuttiCliJson,
} from "../../src/tutti/cli-json-runner.js";
import {
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "../../src/tutti/index.js";

const cleanup: string[] = [];

async function executable(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "agent-acp-kit-tutti-cli-"));
  cleanup.push(dir);
  const file = join(dir, "tutti-test");
  if (process.platform === "win32") {
    // Windows cannot spawn shebang scripts directly; wrap the script in a
    // .cmd shim so tests exercise the real batch-shim execution path.
    const cmd = `${file}.cmd`;
    await writeFile(
      cmd,
      `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`,
      "utf8",
    );
    await writeFile(file, `#!/usr/bin/env node\n${source}\n`, "utf8");
    return cmd;
  }
  await writeFile(file, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runTuttiCliJson", () => {
  it("executes argv without a shell and parses JSON", async () => {
    const command = await executable(
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));`,
    );
    await expect(
      runTuttiCliJson({ command, args: ["--json", "agent", "providers"] }),
    ).resolves.toEqual({ argv: ["--json", "agent", "providers"] });
  });

  it("passes the caller-provided environment to the immediate child", async () => {
    const command = await executable(`process.stdout.write(JSON.stringify({
      base: process.env.BASE_VALUE,
      appData: process.env.TUTTI_APP_DATA_DIR,
    }));`);
    const baseEnv = {
      PATH: process.env.PATH,
      BASE_VALUE: "base",
      TUTTI_APP_DATA_DIR: "/workspace/.tsh/apps/data/example",
    };
    const detectContext = {
      redactionSecrets: ["existing-secret"],
    };

    await expect(
      runTuttiCliJson({
        command,
        args: [],
        env: baseEnv,
        detectContext,
      }),
    ).resolves.toEqual({
      base: "base",
      appData: "/workspace/.tsh/apps/data/example",
    });
    expect(baseEnv.TUTTI_APP_DATA_DIR).toBe(
      "/workspace/.tsh/apps/data/example",
    );
  });

  it("does not rehydrate ambient host env over an explicit direct-mode env", async () => {
    const command = await executable(`process.stdout.write("{}");`);
    vi.stubEnv("TUTTI_CLI", command);
    vi.stubEnv("TSH_WORKSPACE_ID", "workspace-1");
    const env = { TUTTI_APP_DATA_DIR: "/tmp/aimc-app-data" };

    expect(
      hasConfiguredTuttiCli({
        env,
      }),
    ).toBe(false);
  });

  it("keeps explicit env authoritative for non-managed requests", () => {
    vi.stubEnv("TUTTI_CLI", "/ambient/tutti");
    expect(hasConfiguredTuttiCli({ env: {} })).toBe(false);
  });

  it("returns an immutable env and merged redaction secrets", () => {
    const baseEnv = { BASE_VALUE: "base" };
    const projection = projectTuttiCliChildProcess({
      baseEnv,
      detectContext: {
        redactionSecrets: ["existing-secret", "request-secret"],
      },
    });

    expect(projection.env).toEqual({ BASE_VALUE: "base" });
    expect(projection.redactionSecrets).toEqual([
      "existing-secret",
      "request-secret",
    ]);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.env)).toBe(true);
    expect(Object.isFrozen(projection.redactionSecrets)).toBe(true);
    expect(baseEnv).toEqual({ BASE_VALUE: "base" });
    expect(
      redactTuttiCliChildProcessText(
        "credential=request-secret",
        projection.redactionSecrets,
      ),
    ).toBe("credential=[REDACTED]");
    expect(
      redactTuttiCliChildProcessText("token-long-secret", [
        "secret",
        "long-secret",
      ]),
    ).toBe("token-[REDACTED]");
  });

  it("classifies timeout and abort without exposing configured secrets", async () => {
    const command = await executable(
      `process.stderr.write("managed-secret"); setInterval(() => {}, 1000);`,
    );
    const diagnosticsContext = {
      redactionSecrets: ["managed-secret"],
    };
    const timeout = await runTuttiCliJson({
      command,
      args: [],
      timeoutMs: 20,
      detectContext: diagnosticsContext,
    }).catch((error) => error);
    expect(timeout).toMatchObject({ code: "cli_timeout" });
    expect(String(timeout)).not.toContain("managed-secret");
    expect(timeout.details).toMatchObject({ stderrBytes: expect.any(Number) });
    expect(timeout.cause).toBeUndefined();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await runTuttiCliJson({
      command,
      args: [],
      signal: controller.signal,
      timeoutMs: 5_000,
      detectContext: diagnosticsContext,
    }).catch((error) => error);
    expect(aborted).toMatchObject({ code: "cli_aborted" });
    expect(String(aborted)).not.toContain("managed-secret");
    expect(aborted.details).toMatchObject({ stderrBytes: expect.any(Number) });
    expect(aborted.cause).toBeUndefined();

    const failed = await runTuttiCliJson({
      args: [],
      runTuttiCli: async () => {
        throw new Error("managed-secret");
      },
    }).catch((error) => error);
    expect(failed).toMatchObject({ code: "cli_execution_failed" });
    expect(failed.cause).toBeUndefined();
  });

  it("keeps non-secret CLI stderr in failure diagnostics", async () => {
    const command = await executable(
      `process.stderr.write("app-cli returned 502\\n"); process.exit(1);`,
    );
    const error = await runTuttiCliJson({ command, args: [] }).catch(
      (candidate) => candidate,
    );

    expect(error).toMatchObject({
      code: "cli_execution_failed",
      details: {
        exitCode: 1,
        stderr: "app-cli returned 502\n",
      },
    });
  });

  it("classifies only the exact missing agent-list command as protocol fallback", async () => {
    const unsupported = await executable(
      `process.stderr.write("unknown command: agent list\\n"); process.exit(2);`,
    );
    await expect(
      runTuttiCliJson({
        command: unsupported,
        args: ["--json", "agent", "list"],
      }),
    ).rejects.toMatchObject({ code: "unsupported_command" });

    const ordinaryFailure = await executable(
      `process.stderr.write("tutti agent list: daemon unavailable\\n"); process.exit(1);`,
    );
    await expect(
      runTuttiCliJson({
        command: ordinaryFailure,
        args: ["--json", "agent", "list"],
      }),
    ).rejects.toMatchObject({ code: "cli_execution_failed" });
  });

  it("redacts configured secrets from CLI stderr diagnostics", async () => {
    const credential = "request-secret-stderr";
    const command = await executable(
      `process.stderr.write(${JSON.stringify(`app-cli failed credential=${credential}`)}); process.exit(1);`,
    );
    const error = await runTuttiCliJson({
      command,
      args: [],
      detectContext: { redactionSecrets: [credential] },
    }).catch((candidate) => candidate);

    expect(error).toMatchObject({
      code: "cli_execution_failed",
      details: { stderr: "app-cli failed credential=[REDACTED]" },
    });
    expect(JSON.stringify(error)).not.toContain(credential);
  });

  it("fails closed for an unknown Windows batch shim", () => {
    expect(() =>
      resolveTuttiCliInvocation(
        "C:\\Program Files\\Tutti\\state\\bin\\tutti.cmd",
        ["--agent-id", "my agent id", "--model", "a&b%c"],
        "win32",
      ),
    ).toThrow("Unsupported Windows batch shim");
  });

  it("resolves a Windows .cmd shim to its real executable when parseable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-acp-kit-tutti-shim-"));
    cleanup.push(dir);
    const shim = join(dir, "tutti.cmd");
    const target = join(dir, "tutti-dev.exe");
    await writeFile(shim, `@echo off\r\n"${target}" %*\r\n`, "utf8");
    await writeFile(target, "placeholder", "utf8");
    await chmod(shim, 0o755);
    await chmod(target, 0o755);

    expect(
      resolveTuttiCliInvocation(shim, ["--json", "agent", "list"], "win32"),
    ).toMatchObject({
      command: target,
      args: ["--json", "agent", "list"],
    });
  });

  it("matches Windows batch shims case-insensitively", () => {
    expect(() => resolveTuttiCliInvocation("TUTTI.CMD", [], "win32")).toThrow(
      "Unsupported Windows batch shim",
    );
  });

  it("keeps a native Windows executable as a direct invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-acp-kit-tutti-native-"));
    cleanup.push(dir);
    const target = join(dir, "tutti.exe");
    await writeFile(target, "placeholder", "utf8");
    await chmod(target, 0o755);
    expect(
      resolveTuttiCliInvocation(target, ["--json"], "win32"),
    ).toMatchObject({
      command: target,
      args: ["--json"],
    });
  });

  it("keeps a native non-Windows executable as a direct invocation", async () => {
    const command = await executable("process.exit(0);");
    expect(
      resolveTuttiCliInvocation(command, ["--json", "agent", "list"], "darwin"),
    ).toMatchObject({ command, args: ["--json", "agent", "list"] });
  });

  it("executes a supported Windows shim safely and a plain script elsewhere", async () => {
    const command = await executable(
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));`,
    );
    await expect(
      runTuttiCliJson({ command, args: ["--json", "agent", "list"] }),
    ).resolves.toEqual({ argv: ["--json", "agent", "list"] });
  });

  it("classifies malformed JSON", async () => {
    const command = await executable(`process.stdout.write("not-json");`);
    await expect(runTuttiCliJson({ command, args: [] })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not expose credential text from malformed CLI output", async () => {
    const credential = "request-secret-malformed-json";
    const command = await executable(
      `process.stdout.write(${JSON.stringify(credential)});`,
    );
    const error = await runTuttiCliJson({
      command,
      args: [],
      detectContext: {
        redactionSecrets: [credential],
      },
    }).catch((candidate) => candidate);

    expect(error).toMatchObject({ code: "invalid_response", details: {} });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(String(error)).not.toContain(credential);
  });
});
