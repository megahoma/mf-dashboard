import type { LocalApp } from "../../entities/microfrontend/index.ts";
import type { LogContext } from "../../shared/logging.ts";
import { fillTemplate, runShell } from "../../shared/shell.ts";

export const REBUILD_TIMEOUT_MS = 5 * 60_000;

export async function runRebuildCommand(
  app: LocalApp,
  template: string,
  log: LogContext,
  run = runShell,
): Promise<void> {
  const started = Date.now();
  log.event("debug", "shell.started", { app: app.name, kind: "rebuild" });
  const code = await run(
    fillTemplate(template, {
      folder: app.folder,
      name: app.name,
      port: app.port == null ? "" : String(app.port),
      tsconfig: app.tsconfig ?? "",
    }),
    app.folder,
    REBUILD_TIMEOUT_MS,
  );
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
    throw new Error(`rebuild command exited ${code}`);
  }
}
