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

export function parseLinkId(linkId: string): RemoteLinkIdentity | null {
  const [consumer, alias, remoteName] = splitRemoteLinkKey(linkId);
  if (!consumer || alias == null || alias === "" || !remoteName) return null;
  return { consumer, alias, remoteName };
}
