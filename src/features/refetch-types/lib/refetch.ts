import {
  confirmInstalledArchive,
  installTypesArchive,
  type InstallTypesResult,
} from "../../../entities/federated-types/index.ts";
import type { LocalApp } from "../../../entities/microfrontend/index.ts";
import { fillTemplate } from "../../../shared/lib/shell.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";
import { REFETCH_TIMEOUT_MS } from "../config/refetch.ts";
import type { Remote, TypesConsumer } from "../models/refetch.ts";
import { dependencyTypesTarget, refetchTarget } from "./targets.ts";

export function dependencyRefetchCommand(
  template: string,
  consumer: LocalApp,
  remote: Remote,
  consumers: readonly TypesConsumer[],
): string {
  return fillTemplate(template, {
    folder: consumer.folder,
    name: consumer.name,
    port: consumer.port == null ? "" : String(consumer.port),
    tsconfig: consumer.tsconfig ?? "",
    typesFolder: dependencyTypesTarget(consumer, remote, consumers),
  });
}

export async function refetchInstalled(input: {
  consumerFolder: string;
  remoteAlias: string;
  typesFolder: string;
  url: string;
  command: string;
  timeoutMs?: number;
  runCommand?: (command: string, cwd: string, timeoutMs: number) => Promise<number>;
  beforeReplace?: () => void;
}): Promise<InstallTypesResult> {
  const destination = refetchTarget(input.consumerFolder, input.remoteAlias, input.typesFolder);
  const timeoutMs = input.timeoutMs ?? REFETCH_TIMEOUT_MS;
  const command = input.command.trim();
  if (command === "") {
    return installTypesArchive({
      url: input.url,
      destination,
      appDir: input.consumerFolder,
      timeoutMs,
      beforeReplace: input.beforeReplace,
    });
  }
  const run = input.runCommand;
  if (!run) throw new Error("refetch command is not runnable");
  const code = await run(command, input.consumerFolder, timeoutMs);
  if (code !== 0)
    throw new DiagnosticError(`refetch command exited ${code}`, {
      stage: "shell",
      reason: "shell-exit",
      exitCode: code,
    });
  return confirmInstalledArchive({
    url: input.url,
    destination,
    appDir: input.consumerFolder,
    timeoutMs,
  });
}
