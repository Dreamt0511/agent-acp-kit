import { spawn } from "node:child_process";

import { StderrBuffer } from "../../process/stderr-buffer.js";
import { resolveWindowsBatchCommand } from "../../process/windows-batch.js";
import { createJsonRpcLineParser, sendJsonRpc } from "./acp-jsonrpc.js";
import { buildAcpSessionNewParams } from "./acp-session.js";

const DEFAULT_MODEL_OPTION = { id: "default", label: "Default (CLI config)" };

export class AcpModelDetectionError extends Error {
  readonly stderr?: string;

  constructor(message: string, stderr?: string) {
    const stderrTail = stderr?.trim();
    super(stderrTail ? `${message}. stderr: ${stderrTail}` : message);
    this.name = "AcpModelDetectionError";
    if (stderrTail) {
      this.stderr = stderrTail;
    }
  }
}

function normalizeAcpModels(
  models: unknown,
  defaultModelOption = DEFAULT_MODEL_OPTION,
) {
  const payload = (models ?? {}) as Record<string, unknown>;
  const available = Array.isArray(payload.availableModels)
    ? payload.availableModels
    : [];
  const currentModelId =
    typeof payload.currentModelId === "string" ? payload.currentModelId : null;
  const seen = new Set([defaultModelOption.id]);
  const out = [defaultModelOption];

  for (const model of available) {
    const record = (model ?? {}) as Record<string, unknown>;
    const id = typeof record.modelId === "string" ? record.modelId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const labelBase = name && name !== id ? `${name} (${id})` : id;
    out.push({
      id,
      label: id === currentModelId ? `${labelBase} (current)` : labelBase,
    });
  }

  return out;
}

export async function detectAcpModels(input: {
  args: string[];
  bin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  redactionSecrets?: string[];
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 15_000;
  return await new Promise<Array<{ id: string; label: string }>>(
    (resolve, reject) => {
      const stderr = new StderrBuffer(16_000, input.redactionSecrets ?? []);
      const batchExec = resolveWindowsBatchCommand(
        input.bin,
        input.args,
        process.platform,
        { env: input.env },
      );
      const child = spawn(batchExec?.command ?? input.bin, batchExec?.args ?? input.args, {
        cwd: input.cwd,
        env: batchExec?.env ? { ...input.env, ...batchExec.env } : input.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...(batchExec?.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let settled = false;
      let expectedId = 1;

      function finish<T>(fn: (value: T) => void, value: T) {
        if (settled) return;
        settled = true;
        fn(value);
      }

      function fail(error: Error) {
        finish(reject, error);
        child.kill("SIGTERM");
      }

      function createDetectionError(message: string) {
        return new AcpModelDetectionError(message, stderr.tail());
      }

      const parser = createJsonRpcLineParser((message) => {
        if (message.error) {
          fail(
            createDetectionError(
              message.error.message ?? "ACP detection failed",
            ),
          );
          return;
        }
        if (message.id !== expectedId) return;
        if (expectedId === 1) {
          expectedId = 2;
          sendJsonRpc(child.stdin, {
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: buildAcpSessionNewParams(input.cwd),
          });
          return;
        }
        const result = (message.result ?? {}) as Record<string, unknown>;
        const models = normalizeAcpModels(result.models);
        finish(resolve, models);
        child.kill("SIGTERM");
      });

      child.stdout.on("data", (chunk: string) => parser.feed(chunk));
      child.stderr.on("data", (chunk: string) => stderr.append(chunk));
      child.on("error", (error) => fail(error));
      child.on("close", (code) => {
        if (settled) return;
        fail(
          createDetectionError(
            code === 0
              ? "ACP model detection exited before completing session/new"
              : `ACP model detection exited with code ${code}`,
          ),
        );
      });

      const timer = setTimeout(() => {
        fail(
          createDetectionError(
            `ACP model detection timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      sendJsonRpc(child.stdin, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent-acp-kit", version: "0.0.0" },
          protocolVersion: 1,
        },
      });

      child.once("close", () => clearTimeout(timer));
    },
  );
}
