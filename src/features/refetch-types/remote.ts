import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import type { LocalApp } from "../../entities/microfrontend/index.ts";
import { runShell } from "../../shared/shell.ts";
import { manifestZipUrl } from "../rebuild-types/zip-url.ts";
import { dependencyRefetchCommand, refetchInstalled } from "./refetch.ts";

export async function installRemoteTypes(
  consumer: LocalApp,
  remote: LocalApp["remotes"][number],
  manifestUrl: string,
  command: string,
  operations = { manifestZipUrl, refetchInstalled, runShell },
  log: LogContext = noLog,
) {
  const started = Date.now();
  log.event("debug", "types.install.started", {
    consumer: consumer.name,
    remote: remote.name,
    manifestUrl,
  });
  let zipUrl: string;
  try {
    zipUrl = await operations.manifestZipUrl({
      appDir: consumer.folder,
      hostName: consumer.name,
      remoteName: remote.name,
      alias: remote.alias,
      manifestUrl,
    });
  } catch (cause) {
    log.event("error", "types.install.failed", {
      consumer: consumer.name,
      remote: remote.name,
      reason: "manifest",
      ...safeError(cause),
    });
    throw new Error(`unreachable dependency: ${remote.name}`, { cause });
  }
  try {
    const installed = await operations.refetchInstalled({
      consumerFolder: consumer.folder,
      remoteAlias: remote.alias,
      typesFolder: consumer.typesFolder,
      url: zipUrl,
      command: dependencyRefetchCommand(command, { ...consumer, alias: remote.alias }),
      runCommand: async (command, cwd, timeoutMs) => {
        const started = Date.now();
        log.event("debug", "shell.started", { app: consumer.name, kind: "fetch" });
        const code = await operations.runShell(command, cwd, timeoutMs);
        log.event("debug", "shell.completed", {
          app: consumer.name,
          kind: "fetch",
          code,
          durationMs: Date.now() - started,
        });
        if (code !== 0)
          log.event("error", "shell.failed", {
            app: consumer.name,
            kind: "fetch",
            reason: "shell-exit",
            exitCode: code,
            durationMs: Date.now() - started,
          });
        return code;
      },
    });
    log.event("debug", "types.install.completed", {
      consumer: consumer.name,
      remote: remote.name,
      durationMs: Date.now() - started,
    });
    return installed;
  } catch (error) {
    log.event("error", "types.install.failed", {
      consumer: consumer.name,
      remote: remote.name,
      reason: "installation",
      ...safeError(error),
    });
    throw error;
  }
}
