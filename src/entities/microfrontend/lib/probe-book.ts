import type {
  ArtifactProbe,
  LinkProbeResult,
  ProbeBook,
  ProbeResult,
  RemoteLink,
  RemoteLinkIdentity,
} from "../models/probe.ts";

export function appProbeId(name: string): string {
  return `app\0${name}`;
}

export function linkProbeId(link: RemoteLink): string {
  return `link\0${remoteLinkKey(link)}\0${link.url ?? ""}`;
}

export function externalManifestId(url: string): string {
  return `extra\0${url}`;
}

export function createProbeBook(): ProbeBook {
  return { apps: new Map(), links: new Map(), extras: new Map(), zips: new Map() };
}

export function putAppResult(book: ProbeBook, name: string, result: ProbeResult): void {
  book.apps.set(appProbeId(name), result);
}

export function putLinkResult(book: ProbeBook, result: LinkProbeResult): void {
  const edge = remoteLinkKey(result.link);
  const nextId = linkProbeId(result.link);
  for (const [id, stored] of book.links) {
    if (remoteLinkKey(stored.link) === edge && id !== nextId) book.links.delete(id);
  }
  book.links.set(nextId, result);
}

export function putLinkResults(book: ProbeBook, results: readonly LinkProbeResult[]): void {
  if (results.length === 0) return;
  const currentIds = new Map<string, string>();
  // Preserve matching IDs' insertion positions just like standalone writes.
  for (const { link } of results) {
    const edge = remoteLinkKey(link);
    if (!currentIds.has(edge)) currentIds.set(edge, linkProbeId(link));
  }
  for (const [id, stored] of book.links) {
    const nextId = currentIds.get(remoteLinkKey(stored.link));
    if (nextId !== undefined && id !== nextId) book.links.delete(id);
  }
  for (const result of results) {
    const edge = remoteLinkKey(result.link);
    const id = linkProbeId(result.link);
    const previous = currentIds.get(edge)!;
    if (previous !== id) book.links.delete(previous);
    book.links.set(id, result);
    currentIds.set(edge, id);
  }
}

export function putExternalResult(book: ProbeBook, url: string, result: ArtifactProbe): void {
  book.extras.set(externalManifestId(url), result);
}

export function remoteLinkKey(link: RemoteLinkIdentity): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
}

export function appPortIsOpen(book: ProbeBook, name: string): boolean {
  return book.apps.get(appProbeId(name))?.portOpen === true;
}

export function splitRemoteLinkKey(key: string): string[] {
  return key.split("\0");
}
