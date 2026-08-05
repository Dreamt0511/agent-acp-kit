import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCommandExecutable } from "../../src/process/command-resolver.js";

describe("resolveCommandExecutable", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("returns an explicit override path unchanged", async () => {
    expect(
      await resolveCommandExecutable({
        command: "codex",
        overridePath: "/tmp/custom-codex",
      }),
    ).toBe("/tmp/custom-codex");
  });

  it("falls back through alternate command names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-command-resolver-"));
    tempDirs.push(dir);
    const openClaude = join(dir, "openclaude");
    writeFileSync(openClaude, "#!/bin/sh\nexit 0\n");
    chmodSync(openClaude, 0o755);

    expect(
      await resolveCommandExecutable({
        command: "agent-acp-kit-definitely-missing",
        env: { PATH: dir },
        fallbackCommands: ["openclaude"],
      }),
    ).toBe(openClaude);
  });
});
