import { describe, expect, it } from "vitest";

import { spawnSupervisedProcess } from "../../src/process/supervisor.js";

describe("spawnSupervisedProcess", () => {
  it("terminates a timed out process and reports the timeout", async () => {
    const processHandle = spawnSupervisedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      killAfterMs: 10,
      prompt: "",
      promptInput: "stdin",
      timeoutMs: 10,
    });

    const result = await processHandle.waitForExit();

    expect(result.timedOut).toBe(true);
    if (process.platform === "win32") {
      // taskkill /t /f terminates without a POSIX-style signal.
      expect(result.signal ?? result.code).toBeTruthy();
    } else {
      expect(result.signal).toBeTruthy();
    }
  });

  it("redacts explicit MCP/tool secrets from stderr tails", async () => {
    const processHandle = spawnSupervisedProcess({
      command: process.execPath,
      args: ["-e", "process.stderr.write('token=tool-secret-123')"],
      cwd: process.cwd(),
      prompt: "",
      promptInput: "stdin",
      redactionSecrets: ["tool-secret-123"],
    });

    await processHandle.waitForExit();

    expect(processHandle.stderr.tail()).toContain("[REDACTED]");
    expect(processHandle.stderr.tail()).not.toContain("tool-secret-123");
  });
});
