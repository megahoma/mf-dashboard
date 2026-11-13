import { DEFAULT_ENV_MODE, DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";

export const WORKSPACE_DEFAULTS = {
  "mf-dashboard.scripts.start": DEFAULT_START_SCRIPT,
  "mf-dashboard.packageManager": "auto",
  "mf-dashboard.probeIntervalMs": 5000,
  "mf-dashboard.typesSettleMs": 15000,
  "mf-dashboard.types.autoCheck": true,
  "mf-dashboard.terminal.reveal": true,
  "mf-dashboard.commands.rebuildTypes": "",
  "mf-dashboard.commands.refetchTypes": "",
  "mf-dashboard.envMode": DEFAULT_ENV_MODE,
  "mf-dashboard.language": "auto",
  "mf-dashboard.structure": "tree",
} as const;
