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
) {
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
    throw new Error(`unreachable dependency: ${remote.name}`, { cause });
  }
  return operations.refetchInstalled({
    consumerFolder: consumer.folder,
    remoteAlias: remote.alias,
    typesFolder: consumer.typesFolder,
    url: zipUrl,
    command: dependencyRefetchCommand(command, { ...consumer, alias: remote.alias }),
    runCommand: operations.runShell,
  });
}
