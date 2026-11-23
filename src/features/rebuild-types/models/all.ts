import type { ConfirmationStore } from "../../../entities/federated-types/index.ts";
import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { SourceProblem } from "../../../shared/models/source-problem.ts";

export type RebuildAllContext = {
  apps: readonly LocalApp[];
  report?: RebuildAllReport;
  target?: string;
  confirmations: ConfirmationStore;
  envMode: string;
  rebuildCommand: string;
  refetchCommand: string;
  zipPathOverride(app: LocalApp): string | undefined;
  rebuildConfigStamp?(app: LocalApp): Promise<string>;
  fingerprintInputs?(
    app: LocalApp,
    customZipPath: string | null,
    tsconfigFingerprint: string,
    external: readonly [string, string, string][],
  ): Promise<string>;
  persist(): void | PromiseLike<void>;
  progress?(name: string, index: number, total: number): void;
  status?(updates: readonly RebuildAppStatus[]): void;
  log?: LogContext;
};

type RebuildIssue = {
  app: string;
  reason: string;
  problems?: readonly SourceProblem[];
};

export type RebuildAppStatus = {
  app: string;
  settingsKey?: string;
  status:
    | "queued"
    | "running"
    | "rebuilt"
    | "current"
    | "installed"
    | "skipped"
    | "failed"
    | "not-applicable";
  reason?: string;
  problems?: readonly SourceProblem[];
  installed?: readonly string[];
};

export type RebuildAllReport = {
  rebuilt: string[];
  current: string[];
  installed: { consumer: string; alias: string }[];
  skipped: RebuildIssue[];
  failed: RebuildIssue[];
};

export function createRebuildAllReport(): RebuildAllReport {
  return { rebuilt: [], current: [], installed: [], skipped: [], failed: [] };
}
