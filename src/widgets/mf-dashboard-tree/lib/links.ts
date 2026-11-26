import {
  remoteLink,
  splitRemoteLinkKey,
  type LocalApp,
  type RemoteLink,
  type RemoteLinkIdentity,
} from "../../../entities/microfrontend/index.ts";

export function beginRefetch(pending: Set<string>, linkId: string): boolean {
  if (pending.has(linkId)) return false;
  pending.add(linkId);
  return true;
}

export function endRefetch(pending: Set<string>, linkId: string): void {
  pending.delete(linkId);
}

export function linksOf(apps: readonly LocalApp[]): RemoteLink[] {
  const links: RemoteLink[] = [];
  for (const app of apps) {
    for (const remote of app.remotes) {
      links.push(remoteLink(app.name, remote));
    }
  }
  return links;
}

const incoming = new WeakMap<readonly LocalApp[], Map<string, RemoteLink[]>>();

export function incomingLinks(apps: readonly LocalApp[], name: string): RemoteLink[] {
  let index = incoming.get(apps);
  if (!index) {
    index = new Map();
    for (const link of linksOf(apps)) {
      const links = index.get(link.remoteName);
      if (links) links.push(link);
      else index.set(link.remoteName, [link]);
    }
    incoming.set(apps, index);
  }
  return index.get(name) ?? [];
}

export function parseLinkId(linkId: string): RemoteLinkIdentity | null {
  const [consumer, alias, remoteName] = splitRemoteLinkKey(linkId);
  if (!consumer || alias == null || alias === "" || !remoteName) return null;
  return { consumer, alias, remoteName };
}
