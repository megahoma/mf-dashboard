import type { LogContext } from "../../../shared/models/logging.ts";

export type ScanOptions = {
  ignorePaths?: readonly string[];
  envMode?: string;
  startScript?: string;
  log?: LogContext;
  dependencies?: Set<string>;
};
