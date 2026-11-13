export {
  defaultWorkspaceSettings,
  mergeMissingApps,
  missingSettingKeys,
  resolveManifestPath,
  resolveStartScript,
  settingsSeed,
  startupLoad,
} from "./lib/defaults.ts";
export type { AppConfig, ScriptSettings, WorkspaceDefaults } from "./models/defaults.ts";
export { WORKSPACE_DEFAULTS } from "./config/defaults.ts";
export { readConfiguredApps } from "./lib/configured-apps.ts";
