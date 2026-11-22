import type { LocalApp } from "../models/config.ts";
import type { RemoteLink } from "../models/probe.ts";

export function appsByName(apps: readonly LocalApp[]): Map<string, LocalApp> {
  return new Map(apps.map((app) => [app.name, app]));
}

export function remoteLink(consumer: string, remote: LocalApp["remotes"][number]): RemoteLink {
  return { consumer, alias: remote.alias, remoteName: remote.name, url: remote.url };
}

export function rootApps(
  loaded: readonly LocalApp[],
  byName: ReadonlyMap<string, LocalApp>,
  structure: "flat" | "tree",
  dependenciesOf: (app: LocalApp) => readonly string[] = (app) =>
    app.remotes.map((remote) => remote.name),
): LocalApp[] {
  const sorted = [...loaded].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (structure === "flat") return sorted;
  const consumed = new Set<string>();
  for (const app of loaded) {
    for (const name of dependenciesOf(app)) {
      if (byName.has(name)) consumed.add(name);
    }
  }
  const entries = sorted.filter((app) => !consumed.has(app.name));
  const reached = new Set<string>();
  const visit = (app: LocalApp): void => {
    if (reached.has(app.name)) return;
    reached.add(app.name);
    for (const name of dependenciesOf(app)) {
      const child = byName.get(name);
      if (child) visit(child);
    }
  };
  for (const app of entries) visit(app);
  for (const app of sorted) {
    if (!reached.has(app.name)) {
      entries.push(app);
      visit(app);
    }
  }
  return entries;
}
