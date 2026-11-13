import * as vscode from "vscode";
import { appPortIsOpen, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { resolveStartScript } from "../../../features/init-settings/index.ts";
import {
  lookupScript,
  readScripts,
  resolvePackageManager,
  startInvocation,
} from "../../../features/start-app/index.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { DashboardSession } from "../models/session.ts";
import { readWorkspaceSettings, workspaceRootFor } from "./workspace-settings.ts";

export async function startRow(
  app: LocalApp,
  session: DashboardSession,
  log: LogContext,
): Promise<void> {
  log.event("info", "start.started", { app: app.name });
  const portOpen = appPortIsOpen(session.book, app.name);
  if (portOpen) {
    log.event("info", "start.skipped", { app: app.name, reason: "port-open" });
    return;
  }
  const settings = readWorkspaceSettings();
  const scriptKey = resolveStartScript(
    {
      "mf-dashboard.scripts.start": settings.startScript,
      "mf-dashboard.apps": settings.apps,
    },
    app.settingsKey ?? app.name,
  );
  const cwd = app.folder;
  const invocation = startInvocation({
    packageManager: resolvePackageManager(workspaceRootFor(app.folder), settings.packageManager),
    scriptKey,
    scriptBody: lookupScript(readScripts(cwd), scriptKey),
    cwd,
    portOpen,
  });
  if (!invocation) {
    log.event("warn", "start.skipped", { app: app.name, reason: "script-missing" });
    session.noteScriptMissing(app.name);
    return;
  }
  session.clearScriptMissing(app.name);
  try {
    const terminal = vscode.window.createTerminal({
      name: `MF ${app.name}`,
      cwd: invocation.cwd,
    });
    terminal.sendText(`${invocation.command} ${invocation.args.join(" ")}`);
    if (settings.terminalReveal) terminal.show();
    log.event("info", "start.completed", { app: app.name, result: "terminal-command-sent" });
  } catch (error) {
    log.event("error", "start.failed", { app: app.name, ...safeError(error) });
    throw error;
  }
}
