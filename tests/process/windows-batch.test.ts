import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWindowsBatchCommand } from "../../src/process/windows-batch.js";

describe("resolveWindowsBatchCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves an absolute extensionless npm launcher to its cmd shim",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-batch-"));
      tempDirs.push(dir);
      const launcher = join(dir, "claude");
      const cliPath = join(dir, "cli.js");
      writeFileSync(cliPath, "");
      writeFileSync(
        `${launcher}.cmd`,
        `@"${process.execPath}" "${cliPath}" %*\r\n`,
      );

      expect(
        resolveWindowsBatchCommand(launcher, ["--version"], "win32"),
      ).toMatchObject({
        command: process.execPath,
        args: [cliPath, "--version"],
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "resolves a PowerShell file launcher without invoking cmd.exe",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-powershell-shim-"));
      tempDirs.push(dir);
      const systemRoot = join(dir, "Windows");
      const powershell = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const shim = join(dir, "cursor-agent.cmd");
      const script = join(dir, "cursor-agent.ps1");
      mkdirSync(dirname(powershell), { recursive: true });
      writeFileSync(powershell, "");
      writeFileSync(script, "");
      writeFileSync(
        shim,
        `@echo off\r\nset "CURSOR_INVOKED_AS=%~nx0"\r\nset "SCRIPT_DIR=%~dp0"\r\n%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n`,
      );

      expect(
        resolveWindowsBatchCommand(shim, ["--version"], "win32", {
          env: { SystemRoot: systemRoot },
        }),
      ).toMatchObject({
        command: powershell,
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "--version",
        ],
        env: { CURSOR_INVOKED_AS: "cursor-agent.cmd" },
      });
    },
  );
});
