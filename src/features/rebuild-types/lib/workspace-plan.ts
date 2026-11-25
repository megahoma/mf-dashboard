import type { LocalApp } from "../../../entities/microfrontend/index.ts";
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

export function workspaceTypesPlan(apps: readonly LocalApp[], target?: string) {
  const groups = new Map<string, LocalApp[]>();
  for (const app of apps) {
    const group = groups.get(app.name) ?? [];
    group.push(app);
    groups.set(app.name, group);
  }
  const conflicts = new Map([...groups].filter(([, group]) => group.length > 1));
  const nodes = new Map<string, WorkspaceTypesNode>();
  for (const app of apps) {
    if (conflicts.has(app.name)) continue;
    const generate = isProducer(app);
    const links = (app.consumeTypes ? app.remotes : []).map((remote) => {
      const url = parseHttpUrl(remote.url);
      const candidates = groups.get(remote.name) ?? [];
      const [candidate] = candidates;
      const ambiguous = candidates.length > 1;
      const workspaceProducer =
        !ambiguous && candidate && candidate !== app && isProducer(candidate)
          ? candidate.name
          : undefined;
      const producer =
        remote.url === null
          ? workspaceProducer
          : ambiguous
            ? candidates
                .map((candidate) => localProducer(url, candidate))
                .find((name) => name !== undefined)
            : localProducer(url, candidate);
      const fallback = generate && url && !producer ? workspaceProducer : undefined;
      return { remote, url, producer, fallback };
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
    const node = nodes.get(name);
    if (!node) {
      complete.add(name);
      return;
    }
    visiting.set(name, stack.length);
    stack.push(name);
    for (const dependency of node.dependencies) visit(dependency);
    stack.pop();
    visiting.delete(name);
    complete.add(name);
    order.push(node);
  };
  if (target === undefined) {
    for (const name of [...nodes.keys()].sort()) visit(name);
  } else {
    visit(target);
  }
  const required = target === undefined ? order : [...order];
  const selectedApps = target === undefined ? apps : apps.filter((app) => complete.has(app.name));
  if (target !== undefined) {
    // Keep fallback candidates and their dependencies available for an actual manifest failure.
    for (const node of order) {
      for (const { fallback } of node.links) if (fallback !== undefined) visit(fallback);
    }
    for (const name of conflicts.keys()) if (!complete.has(name)) conflicts.delete(name);
  }
  return {
    order: required,
    candidates: target === undefined ? nodes : new Map(order.map((node) => [node.app.name, node])),
    cycles,
    conflicts,
    apps: selectedApps,
  };
}
