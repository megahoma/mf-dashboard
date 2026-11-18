import type { LogContext } from "../../../shared/models/logging.ts";

export type FederationOwnershipCheck = (file: string, name: string, origin: string) => boolean;

export type ScanOptions = {
  ignorePaths?: readonly string[];
  envMode?: string;
  startScript?: string;
  log?: LogContext;
  dependencies?: Set<string>;
  ownershipSources?: Set<string>;
};
