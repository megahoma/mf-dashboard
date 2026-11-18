import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import type { RebuildAllReport } from "../../../features/rebuild-types/index.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { DashboardSettings, WorkspaceRoot } from "../models/session-types.ts";
import { resolveKnownApps } from "./known-apps.ts";

export function resolveRebuildApps(
  roots: readonly WorkspaceRoot[],
  settings: DashboardSettings,
  log: LogContext,
) {
  const apps: LocalApp[] = [];
  const skipped: RebuildAllReport["skipped"] = [];
  const zipPaths = new Map<string, string>();
  const configured = settings.apps ?? {};
  const configErrors = new Map<string, string>();
  const resolved = resolveKnownApps(
    roots,
    configured,
    settings.envMode,
    undefined,
    log,
    (name, error) => {
      configErrors.set(name, String(error));
      log.event("warn", "types.rebuild.all.config-failed", { app: name, ...safeError(error) });
    },
    settings.startScript,
    settings.ignorePaths,
    undefined,
    true,
  );
  for (const [name, setting] of Object.entries(configured)) {
    const app = resolved.get(name);
    if (!app) {
      skipped.push({
        app: name,
        reason: configErrors.get(name) ?? "Could not read the microfrontend config",
      });
      continue;
    }
    apps.push(app);
    if (typeof setting.typesZipPath === "string") zipPaths.set(app.name, setting.typesZipPath);
  }
  return { apps, skipped, zipPaths };
}
