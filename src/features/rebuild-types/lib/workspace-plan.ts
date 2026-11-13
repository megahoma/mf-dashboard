import { appsByName, type LocalApp } from "../../../entities/microfrontend/index.ts";
import { isLoopbackAtPort, localManifestUrl, parseHttpUrl } from "../../../shared/lib/urls.ts";
import type { WorkspaceTypesNode } from "../models/plan.ts";

function isProducer(app: LocalApp): boolean {
  return app.generateTypes && app.hasExposes !== false;
}

function localProducer(url: URL | null, app: LocalApp | undefined): string | undefined {
  if (!url || !app || !isProducer(app) || app.port == null || !isLoopbackAtPort(url, app.port))
    return undefined;
  for (const route of [app.manifestPath, app.devManifestPath]) {
    if (route === undefined) continue;
    const manifest = parseHttpUrl(localManifestUrl(app.port, route));
    if (url.pathname === manifest?.pathname && url.search === manifest.search) return app.name;
  }
}

export function workspaceTypesPlan(apps: readonly LocalApp[]) {
  const byName = appsByName(apps);
  if (byName.size !== apps.length) throw new Error("Microfrontend names must be unique");
  const nodes = new Map<string, WorkspaceTypesNode>();
  for (const app of apps) {
    const generate = isProducer(app);
    const links = (app.consumeTypes ? app.remotes : []).map((remote) => {
      const url = parseHttpUrl(remote.url);
      return { remote, url, producer: localProducer(url, byName.get(remote.name)) };
    });
    const dependencies = [
      ...new Set(links.map(({ producer }) => producer).filter((name) => name !== undefined)),
    ].sort();
    if (generate || dependencies.length || links.some(({ url }) => url === null))
      nodes.set(app.name, { app, generate, links, dependencies });
  }
  const order: WorkspaceTypesNode[] = [];
  const complete = new Set<string>();
  const stack: string[] = [];
  const visiting = new Map<string, number>();
  const cycles = new Map<string, string>();
  const visit = (name: string) => {
    if (complete.has(name)) return;
    const start = visiting.get(name);
    if (start !== undefined) {
      const members = stack.slice(start);
      const reason = `Dependency cycle: ${[...members, name].join(" → ")}`;
      for (const member of members) cycles.set(member, reason);
      return;
    }
    const node = nodes.get(name)!;
    visiting.set(name, stack.length);
    stack.push(name);
    for (const dependency of node.dependencies) visit(dependency);
    stack.pop();
    visiting.delete(name);
    complete.add(name);
    order.push(node);
  };
  for (const name of [...nodes.keys()].sort()) visit(name);
  return { order, cycles };
}
