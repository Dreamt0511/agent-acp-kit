import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProcessInvocation } from "../../src/process/process-adapter.js";

describe("resolveProcessInvocation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("turns a known Windows node shim into a shell-free invocation", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-process-adapter-"));
    tempDirs.push(dir);
    const shim = join(dir, "agent.cmd");
    const node = join(dir, "node.exe");
    const cliPath = join(dir, "cli.js");
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(shim, `@"${node}" "${cliPath}" %*\r\n`);
    chmodSync(shim, 0o755);

    expect(
      resolveProcessInvocation({
        command: shim,
        args: ["--model", "a&b%c"],
        platform: "win32",
      }),
    ).toMatchObject({
      command: node,
      args: [cliPath, "--model", "a&b%c"],
    });
  });

  it("gives an exact override precedence over a batch command name", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-process-override-"));
    tempDirs.push(dir);
    const shim = join(dir, "agent.cmd");
    const override = join(dir, "configured agent.exe");
    writeFileSync(shim, "@echo off\r\n");
    writeFileSync(override, "");
    chmodSync(shim, 0o755);
    chmodSync(override, 0o755);

    expect(
      resolveProcessInvocation({
        command: shim,
        args: ["--version"],
        overridePath: override,
        platform: "win32",
      }),
    ).toMatchObject({ command: override, args: ["--version"] });
  });

  it("resolves an explicit batch command name from PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-process-path-"));
    tempDirs.push(dir);
    const shim = join(dir, "agent.cmd");
    const node = join(dir, "node.exe");
    const cliPath = join(dir, "cli.js");
    writeFileSync(node, "");
    writeFileSync(cliPath, "");
    writeFileSync(shim, `@"${node}" "${cliPath}" %*\r\n`);
    chmodSync(shim, 0o755);

    expect(
      resolveProcessInvocation({
        command: "agent.cmd",
        args: ["--version"],
        env: { PATH: dir, PATHEXT: ".CMD;.EXE" },
        platform: "win32",
      }),
    ).toMatchObject({ command: node, args: [cliPath, "--version"] });
  });
});
