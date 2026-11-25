import { logDuration } from "../../shared/lib/logging.ts";
import type { LogContext } from "../../shared/models/logging.ts";
import type { MfDashboardProvider } from "../../widgets/mf-dashboard-tree/index.ts";

export async function openPanel(provider: MfDashboardProvider, log: LogContext): Promise<void> {
  log = log.operation("startup");
  const started = Date.now();
  log.event("info", "startup.started");
  try {
    await provider.refresh("startup");
    logDuration(log, "startup.completed", started, {}, "info");
  } finally {
    provider.armProbe();
  }
}
