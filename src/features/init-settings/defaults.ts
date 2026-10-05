export interface AppConfig {
  path: string;
  workspaceFolder?: string;
  manifestPath?: string;
  scripts?: { start?: string };
}

export interface WorkspaceDefaults {
  "mf-dashboard.scripts.start": string;
  "mf-dashboard.packageManager": "auto";
  "mf-dashboard.probeIntervalMs": number;
  "mf-dashboard.typesSettleMs": number;
  "mf-dashboard.terminal.reveal": boolean;
  "mf-dashboard.commands.rebuildTypes": string;
  "mf-dashboard.commands.refetchTypes": string;
  "mf-dashboard.envMode": string;
  "mf-dashboard.language": "auto";
  "mf-dashboard.structure": "flat" | "tree";
  "mf-dashboard.ignorePaths": string[];
  "mf-dashboard.extraManifestUrls": string[];
}

export interface ScriptSettings {
  "mf-dashboard.scripts.start": string;
  "mf-dashboard.apps"?: Record<
    string,
    { path?: string; manifestPath?: string; scripts?: { start?: string } }
  >;
}

// The manager is resolved from the workspace when starting an app.
export function defaultWorkspaceSettings(): WorkspaceDefaults {
  return {
    "mf-dashboard.scripts.start": "dev",
    "mf-dashboard.packageManager": "auto",
    "mf-dashboard.probeIntervalMs": 5000,
    "mf-dashboard.typesSettleMs": 15000,
    "mf-dashboard.terminal.reveal": true,
    "mf-dashboard.commands.rebuildTypes": "",
    "mf-dashboard.commands.refetchTypes": "",
    "mf-dashboard.envMode": "development",
    "mf-dashboard.language": "auto",
    "mf-dashboard.structure": "tree",
    "mf-dashboard.ignorePaths": [],
    "mf-dashboard.extraManifestUrls": [],
  };
}

export function resolveStartScript(settings: ScriptSettings, name: string): string {
  const start = settings["mf-dashboard.apps"]?.[name]?.scripts?.start;
  if (typeof start === "string") return start;
  return settings["mf-dashboard.scripts.start"];
}

export function resolveManifestPath(settings: ScriptSettings, name: string): string {
  const manifestPath = settings["mf-dashboard.apps"]?.[name]?.manifestPath;
  if (typeof manifestPath === "string" && manifestPath !== "") return manifestPath;
  return "/mf-manifest.json";
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
