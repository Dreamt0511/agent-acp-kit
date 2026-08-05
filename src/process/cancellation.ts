import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createAbortError(message = "Operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Terminates a supervised child. On Windows, an executable may create its own
 * children; `child.kill()` only terminates that single process. `taskkill /t /f`
 * terminates the entire process tree so cancellation cannot leave the agent
 * running after the runtime reports the run as canceled.
 */
export function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let fallbackStarted = false;
    const fallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    killer.once("error", fallback);
    killer.once("close", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  child.kill(signal);
}

export function attachAbortSignal(
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal,
  options?: { killAfterMs?: number },
) {
  if (!signal) {
    return () => {};
  }
  let killFallback: NodeJS.Timeout | undefined;

  const abort = () => {
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, "SIGTERM");
      killFallback = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateProcessTree(child, "SIGKILL");
        }
      }, options?.killAfterMs ?? 2_000);
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
    if (killFallback) {
      clearTimeout(killFallback);
    }
  };
}
