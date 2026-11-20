import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { TOKENS } from "../config/shell.ts";
import { DiagnosticError } from "../models/diagnostic-error.ts";

// One shell word. A federation name or path cannot close the quote and run another command.
export function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fillTemplate(
  template: string,
  values: Partial<Record<(typeof TOKENS)[number], string>>,
): string {
  return template.replace(
    /\{(folder|name|port|tsconfig|typesFolder)\}/g,
    (token, key: (typeof TOKENS)[number]) => {
      const value = values[key];
      return value == null ? token : shellQuote(value);
    },
  );
}

// Do not release the caller's queue while a timed-out generator can still write.
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  output?: (chunk: Buffer, stream: "stdout" | "stderr") => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: output ? ["ignore", "pipe", "pipe"] : "ignore",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let capture = output;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const streams = ["stdout", "stderr"] as const;
    for (const stream of streams)
      child[stream]?.on("data", (chunk: Buffer) => capture?.(chunk, stream));
    const timer = setTimeout(() => {
      timedOut = true;
      capture = undefined;
      void stopProcessTree(child.pid).then(
        () =>
          reject(
            new DiagnosticError(`timeout ${timeoutMs}`, {
              stage: "shell",
              reason: "timeout",
              timeoutMs,
            }),
          ),
        (error: unknown) =>
          reject(new Error("Could not stop timed-out shell process tree", { cause: error })),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!timedOut) reject(error);
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      capture = undefined;
      if (!timedOut) resolve(code ?? 1);
    };
    child.once("close", finish);
    child.once("exit", (code) => {
      if (!output || timedOut) return;
      clearTimeout(timer);
      // Let inherited pipes drain without waiting for background jobs or breaking their writes.
      for (const stream of streams) {
        const pipe = child[stream];
        if (pipe instanceof Socket) pipe.unref();
      }
      drainTimer = setTimeout(() => finish(code), 50);
    });
  });
}

export async function stopProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || code === 128)
          resolve(); // 128: process has already exited.
        else reject(new Error(`taskkill exited with ${code}`));
      });
    });
    return;
  }
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signal("SIGTERM")) return;
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!signal(0)) return;
  signal("SIGKILL");
  // A shell exiting does not imply its descendants have exited as well.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!signal(0)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Process group did not exit after SIGKILL");
}
