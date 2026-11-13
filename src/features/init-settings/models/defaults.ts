export type AppConfig = {
  path: string;
  workspaceFolder?: string;
  manifestPath?: string;
  scripts?: { start?: string };
};

export type WorkspaceDefaults = {
  "mf-dashboard.scripts.start": string;
  "mf-dashboard.packageManager": "auto";
  "mf-dashboard.probeIntervalMs": number;
  "mf-dashboard.typesSettleMs": number;
  "mf-dashboard.types.autoCheck": boolean;
  "mf-dashboard.terminal.reveal": boolean;
  "mf-dashboard.commands.rebuildTypes": string;
  "mf-dashboard.commands.refetchTypes": string;
  "mf-dashboard.envMode": string;
  "mf-dashboard.language": "auto";
  "mf-dashboard.structure": "flat" | "tree";
  "mf-dashboard.ignorePaths": string[];
  "mf-dashboard.extraManifestUrls": string[];
};

export type ScriptSettings = {
  "mf-dashboard.scripts.start": string;
  "mf-dashboard.apps"?: Record<
    string,
    { path?: string; manifestPath?: string; scripts?: { start?: string } }
  >;
};
