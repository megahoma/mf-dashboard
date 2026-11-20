import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import { fillTemplate, runShell } from "../../../shared/lib/shell.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { LocatedError } from "../../../shared/models/source-problem.ts";
import { REBUILD_TIMEOUT_MS } from "../config/command.ts";
import { compilerProblems, COMPILER_OUTPUT_LIMIT } from "./compiler-problems.mts";

export async function runRebuildCommand(
  app: LocalApp,
  template: string,
  log: LogContext,
  run = runShell,
): Promise<void> {
  const started = Date.now();
  log.event("debug", "shell.started", { app: app.name, kind: "rebuild" });
  const command = fillTemplate(template, {
    folder: app.folder,
    name: app.name,
    port: app.port == null ? "" : String(app.port),
    tsconfig: app.tsconfig ?? "",
  });
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  let remaining = COMPILER_OUTPUT_LIMIT;
  const code = await run(command, app.folder, REBUILD_TIMEOUT_MS, (chunk, stream) => {
    if (remaining === 0) return;
    const part = chunk.subarray(0, remaining);
    chunks[stream].push(part);
    remaining -= part.length;
  });
  const durationMs = Date.now() - started;
  log.event("debug", "shell.completed", { app: app.name, kind: "rebuild", code, durationMs });
  if (code !== 0) {
    log.event("error", "shell.failed", {
      app: app.name,
      kind: "rebuild",
      reason: "shell-exit",
      exitCode: code,
      durationMs,
    });
    const message = `rebuild command exited ${code}`;
    const output = [chunks.stdout, chunks.stderr]
      .map((stream) => Buffer.concat(stream).toString("utf8"))
      .join("\n");
    const problems = compilerProblems(output, app.folder);
    throw problems.length ? new LocatedError(message, problems) : new Error(message);
  }
}
