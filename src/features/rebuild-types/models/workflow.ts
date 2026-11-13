import type { ConfirmationStore } from "../../../entities/federated-types/index.ts";
import type { LocalApp, ProbeBook } from "../../../entities/microfrontend/index.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { ScriptSettings } from "../../init-settings/index.ts";

export type RebuildContext = {
  log?: LogContext;
  apps: readonly LocalApp[];
  book: ProbeBook;
  confirmations: ConfirmationStore;
  published: Map<string, string>;
  settings: ScriptSettings & { rebuildCommand: string; envMode: string };
  refetchCommand(): string;
  persist(): void | PromiseLike<void>;
  rebuilt(name: string): void;
};
