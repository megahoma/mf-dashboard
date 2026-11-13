import { WORKSPACE_DEFAULTS } from "../config/defaults.ts";
import type { AppConfig, ScriptSettings, WorkspaceDefaults } from "../models/defaults.ts";

// The manager is resolved from the workspace when starting an app.
export function defaultWorkspaceSettings(): WorkspaceDefaults {
  return {
    ...WORKSPACE_DEFAULTS,
    "mf-dashboard.ignorePaths": [],
    "mf-dashboard.extraManifestUrls": [],
  };
}

export function resolveStartScript(settings: ScriptSettings, name: string): string {
  const start = settings["mf-dashboard.apps"]?.[name]?.scripts?.start;
  if (typeof start === "string") return start;
  return settings["mf-dashboard.scripts.start"];
}

export function resolveManifestPath(override: string | undefined, detectedPath: string): string {
  return typeof override === "string" && override !== "" ? override : detectedPath;
}

export function mergeMissingApps<T extends AppConfig>(
  existing: Record<string, T> | undefined,
  found: Record<string, T>,
): Record<string, T> {
  const apps: Record<string, T> = { ...(existing ?? {}) };
  for (const [name, value] of Object.entries(found)) {
    if (Object.hasOwn(apps, name)) continue;
    Object.defineProperty(apps, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return apps;
}

export function missingSettingKeys(
  defined: readonly string[],
  defaults: WorkspaceDefaults = defaultWorkspaceSettings(),
): string[] {
  const present = new Set(defined);
  return Object.keys(defaults).filter((key) => !present.has(key));
}

// Missing apps means the first open must scan. A saved map is only reread.
export function startupLoad(appsDefined: boolean): "discover" | "refresh" {
  return appsDefined ? "refresh" : "discover";
}

// An empty scan writes nothing. A workspace that has configs receives only keys the user has not set.
export function settingsSeed(
  foundConfigNames: readonly string[],
  definedKeys: readonly string[],
): Partial<WorkspaceDefaults> {
  if (foundConfigNames.length === 0) return {};
  const defaults = defaultWorkspaceSettings();
  const seed: Partial<WorkspaceDefaults> = { ...defaults };
  for (const key of definedKeys) delete seed[key as keyof WorkspaceDefaults];
  return seed;
}
