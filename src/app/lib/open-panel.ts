import { startupLoad } from "../../features/init-settings/index.ts";
import { logDuration } from "../../shared/lib/logging.ts";
import { dashboardConfiguration, isConfigured } from "../../shared/lib/workspace.ts";
import type { LogContext } from "../../shared/models/logging.ts";
import type { MfDashboardProvider } from "../../widgets/mf-dashboard-tree/index.ts";
import { ensureWorkspaceSettings } from "./workspace-settings.ts";

export async function openPanel(provider: MfDashboardProvider, log: LogContext): Promise<void> {
  log = log.operation("startup");
  const started = Date.now();
  log.event("info", "startup.started");
  try {
    await ensureWorkspaceSettings(provider.session, log);
    const appsDefined = isConfigured(dashboardConfiguration().inspect("apps"));
    if (startupLoad(appsDefined) === "discover") await provider.discover();
    else await provider.refresh("startup");
    logDuration(log, "startup.completed", started, {}, "info");
  } finally {
    provider.armProbe();
  }
}
