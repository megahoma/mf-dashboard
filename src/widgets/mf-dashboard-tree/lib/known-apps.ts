import fs from "node:fs";
import path from "node:path";
import { readAppFolder, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { resolveManifestPath } from "../../../features/init-settings/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { AppParseCache, AppSetting, WorkspaceRoot } from "../models/session-types.ts";
import { createAppParseCache } from "./app-parse-cache.ts";

export function loadKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  _ignorePaths: readonly string[] = [],
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  startScript = DEFAULT_START_SCRIPT,
): LocalApp[] {
  return [...resolveKnownApps(roots, apps, envMode, cache, log, undefined, startScript).values()];
}

export function appParseKey(
  root: string,
  folder: string,
  envMode: string,
  name: string,
  script: string,
  configFile?: string,
): string {
  return JSON.stringify([root, folder, envMode, name, script, configFile]);
}

export function resolveKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  onError?: (name: string, error: unknown) => void,
  startScript = DEFAULT_START_SCRIPT,
): Map<string, LocalApp> {
  const entries: { name: string; app: LocalApp; identity: string }[] = [];
  const matches = new Map<string, number>();
  for (const [name, setting] of Object.entries(apps)) {
    if (!setting || typeof setting.path !== "string" || setting.path.trim() === "") continue;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    const script = typeof setting.scripts?.start === "string" ? setting.scripts.start : startScript;
    const configFile = typeof setting.configFile === "string" ? setting.configFile : undefined;
    try {
      for (const root of candidates) {
        const confined = confinedAppPath(root.path, setting.path);
        if (!confined) {
          log.event("warn", "config.path.invalid", { app: name });
          continue;
        }
        const { absolute, canonical } = confined;
        const key = appParseKey(root.path, absolute, envMode, name, script, configFile);
        const cached = cache.lookup(key, absolute, envMode);
        const dependencies = new Set<string>();
        const parsed =
          cached ?? readAppFolder(absolute, envMode, name, dependencies, log, script, configFile);
        if (!parsed) continue;
        const app = cached ?? { ...parsed, configDependencies: [...dependencies] };
        if (!cached) cache.store(key, absolute, envMode, app, [...dependencies]);
        if (app.name !== name && candidates.length !== 1) continue;
        const identity = `${canonical}\0${app.name}`;
        matches.set(identity, (matches.get(identity) ?? 0) + 1);
        const resolved = withManifestPathOverride(app, setting.manifestPath);
        resolved.settingsKey = name;
        entries.push({ name, app: resolved, identity });
        break;
      }
    } catch (error) {
      if (!onError) throw error;
      onError(name, error);
    }
  }
  const loaded = new Map<string, LocalApp>();
  for (const { name, app, identity } of entries) {
    if (name === app.name || matches.get(identity) === 1) loaded.set(name, app);
  }
  return loaded;
}

function withManifestPathOverride(app: LocalApp, configuredPath: string | undefined): LocalApp {
  const override = resolveManifestPath(configuredPath, "");
  return override ? { ...app, manifestPath: override, devManifestPath: undefined } : { ...app };
}

function confinedAppPath(
  root: string,
  settingPath: string,
): { absolute: string; canonical: string } | null {
  const base = path.resolve(root);
  const absolute = path.resolve(base, settingPath);
  if (!pathIsInside(base, absolute)) return null;
  try {
    if (!fs.existsSync(absolute)) return { absolute, canonical: absolute };
    const canonical = fs.realpathSync.native(absolute);
    return pathIsInside(fs.realpathSync.native(base), canonical) ? { absolute, canonical } : null;
  } catch {
    return null;
  }
}

export function workspaceRelative(root: string, folder: string): string {
  const relative = path.relative(root, folder);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}
