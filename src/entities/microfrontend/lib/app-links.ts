import type { LocalApp } from "../models/config.ts";
import type { RemoteLink } from "../models/probe.ts";

export function appsByName(apps: readonly LocalApp[]): Map<string, LocalApp> {
  return new Map(apps.map((app) => [app.name, app]));
}

export function remoteLink(consumer: string, remote: LocalApp["remotes"][number]): RemoteLink {
  return { consumer, alias: remote.alias, remoteName: remote.name, url: remote.url };
}
