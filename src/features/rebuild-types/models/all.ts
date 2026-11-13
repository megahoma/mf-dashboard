import type { ConfirmationStore } from "../../../entities/federated-types/index.ts";
import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import type { LogContext } from "../../../shared/models/logging.ts";

export type RebuildAllContext = {
  apps: readonly LocalApp[];
  confirmations: ConfirmationStore;
  envMode: string;
  rebuildCommand: string;
  refetchCommand: string;
  zipPathOverride(app: LocalApp): string | undefined;
  persist(): void | PromiseLike<void>;
  progress?(name: string, index: number, total: number): void;
  log?: LogContext;
};

type RebuildIssue = {
  app: string;
  reason: string;
};

export type RebuildAllReport = {
  rebuilt: string[];
  current: string[];
  installed: { consumer: string; alias: string }[];
  skipped: RebuildIssue[];
  failed: RebuildIssue[];
};
