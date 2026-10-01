import { createHash } from "node:crypto";
import { filesFingerprint } from "../../shared/fingerprint.ts";
import type { LocalApp } from "./discover.ts";

export { filesFingerprint };

// Manifest requests in the proved 2.9.1 path use a 10s timeout.
const REQUEST_TIMEOUT_MS = 10_000;

export interface Net {
  connect(port: number): Promise<boolean>;
  get(url: string): Promise<{
    ok: boolean;
    status?: number;
    json: unknown | null;
    body: Uint8Array | null;
    lastModified: number | null;
  }>;
}

export interface ArtifactProbe {
  manifestReachable: boolean;
  requestFailure?: "timeout" | "network" | `HTTP ${number}` | "HTTP error";
  buildVersion: string | null;
  zipUrl: string | null;
  zipMtime: number | null;
  zipHash: string | null;
}

export interface ProbeResult extends ArtifactProbe {
  portOpen: boolean;
}

export interface RemoteLink {
  consumer: string;
  alias: string;
  remoteName: string;
  url: string | null;
}

export interface LinkProbeResult extends ArtifactProbe {
  link: RemoteLink;
}

export interface ProbeBook {
  apps: Map<string, ProbeResult>;
  links: Map<string, LinkProbeResult>;
  extras: Map<string, ArtifactProbe>;
}

export interface ProbeCycleInput {
  apps: readonly LocalApp[];
  links: readonly RemoteLink[];
  extraManifestUrls: readonly string[];
}

export interface InstallConfirmation {
  consumer: string;
  alias: string;
  remoteName: string;
  url: string;
  zipHash: string;
  filesFingerprint: string;
}

export interface GenerationConfirmation {
  name: string;
  zipHash: string;
  sourceFingerprint: string;
  builtDependencyHashes: Record<string, string>;
}

export interface ConfirmationSnapshot {
  installs: InstallConfirmation[];
  generations: GenerationConfirmation[];
}

export interface ConfirmationStore {
  saveInstall(link: RemoteLink, filesFingerprint: string, zipHash: string): void;
  installConfirmed(link: RemoteLink, filesFingerprint: string, zipHash: string): boolean;
  saveGeneration(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
  ): void;
  generationConfirmed(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
  ): boolean;
  snapshot(): ConfirmationSnapshot;
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const WEEKDAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const WEEKDAY_LONG = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const IMF = new RegExp(
  `^(?:${WEEKDAY}), (\\d{2}) (${MONTH}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const RFC850 = new RegExp(
  `^(?:${WEEKDAY_LONG}), (\\d{2})-(${MONTH})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const ASCTIME = new RegExp(
  `^(?:${WEEKDAY}) (${MONTH}) ([ \\d]\\d) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
);

export function httpDateMs(header: string | null): number | null {
  if (header == null) return null;
  const value = header.trim();
  const imf = IMF.exec(value);
  if (imf)
    return utcDate(
      Number(imf[3]),
      MONTHS[imf[2]],
      Number(imf[1]),
      Number(imf[4]),
      Number(imf[5]),
      Number(imf[6]),
    );
  const rfc = RFC850.exec(value);
  if (rfc) {
    const year = Number(rfc[3]);
    return utcDate(
      year >= 70 ? 1900 + year : 2000 + year,
      MONTHS[rfc[2]],
      Number(rfc[1]),
      Number(rfc[4]),
      Number(rfc[5]),
      Number(rfc[6]),
    );
  }
  const asctime = ASCTIME.exec(value);
  if (asctime) {
    return utcDate(
      Number(asctime[6]),
      MONTHS[asctime[1]],
      Number(asctime[2]),
      Number(asctime[3]),
      Number(asctime[4]),
      Number(asctime[5]),
    );
  }
  return null;
}

export function appProbeId(name: string): string {
  return `app\0${name}`;
}

export function linkProbeId(link: RemoteLink): string {
  return `link\0${link.consumer}\0${link.alias}\0${link.remoteName}\0${link.url ?? ""}`;
}

export function externalManifestId(url: string): string {
  return `extra\0${url}`;
}

export function createProbeBook(): ProbeBook {
  return { apps: new Map(), links: new Map(), extras: new Map() };
}

export function putAppResult(book: ProbeBook, name: string, result: ProbeResult): void {
  book.apps.set(appProbeId(name), result);
}

export function putLinkResult(book: ProbeBook, result: LinkProbeResult): void {
  const edge = edgeKey(result.link);
  const nextId = linkProbeId(result.link);
  for (const [id, stored] of book.links) {
    if (edgeKey(stored.link) === edge && id !== nextId) book.links.delete(id);
  }
  book.links.set(nextId, result);
}

export function putExternalResult(book: ProbeBook, url: string, result: ArtifactProbe): void {
  book.extras.set(externalManifestId(url), result);
}

export function createConfirmationStore(snapshot?: ConfirmationSnapshot): ConfirmationStore {
  const installs = new Map<string, InstallConfirmation>();
  const generations = new Map<string, GenerationConfirmation>();
  for (const record of snapshot?.installs ?? []) installs.set(edgeKey(record), copyInstall(record));
  for (const record of snapshot?.generations ?? [])
    generations.set(record.name, copyGeneration(record));
  return {
    saveInstall(link, fingerprint, zipHash) {
      if (link.url == null || link.url.trim() === "") return;
      installs.set(edgeKey(link), {
        consumer: link.consumer,
        alias: link.alias,
        remoteName: link.remoteName,
        url: link.url,
        filesFingerprint: fingerprint,
        zipHash,
      });
    },
    installConfirmed(link, fingerprint, zipHash) {
      const record = installs.get(edgeKey(link));
      if (!record || link.url == null) return false;
      return (
        record.url === link.url &&
        record.filesFingerprint === fingerprint &&
        record.zipHash === zipHash
      );
    },
    saveGeneration(name, sourceFingerprint, zipHash, builtDependencyHashes) {
      generations.set(name, {
        name,
        sourceFingerprint,
        zipHash,
        builtDependencyHashes: { ...builtDependencyHashes },
      });
    },
    generationConfirmed(name, sourceFingerprint, zipHash, builtDependencyHashes) {
      const record = generations.get(name);
      if (!record) return false;
      return (
        record.zipHash === zipHash &&
        record.sourceFingerprint === sourceFingerprint &&
        sameHashes(record.builtDependencyHashes, builtDependencyHashes)
      );
    },
    snapshot() {
      return {
        installs: [...installs.values()].map(copyInstall),
        generations: [...generations.values()].map(copyGeneration),
      };
    },
  };
}

export function createProbeCycle(
  net: Net,
  book: ProbeBook,
): { start(input: ProbeCycleInput): Promise<boolean> } {
  let inflight: Promise<void> | null = null;
  return {
    start(input) {
      if (inflight) return Promise.resolve(false);
      const run = (async () => {
        for (const app of input.apps) putAppResult(book, app.name, await probeApp(app, net));
        for (const link of input.links) putLinkResult(book, await probeLink(link, net));
        for (const url of input.extraManifestUrls)
          putExternalResult(book, url, await probeManifest(url, net));
      })();
      inflight = run.finally(() => {
        inflight = null;
      });
      return inflight.then(() => true);
    },
  };
}

// connect(port) is a loopback check on 127.0.0.1. The host is not a remote URL.
export async function probeApp(app: LocalApp, net: Net): Promise<ProbeResult> {
  if (app.port == null) return emptyResult(false);
  const opened = await callNet(net.connect(app.port));
  const portOpen = opened === true;
  if (!portOpen || !app.manifest) return emptyResult(portOpen);
  return { portOpen, ...(await probeManifest(localManifestUrl(app.port, app.manifestPath), net)) };
}

export async function probeLink(link: RemoteLink, net: Net): Promise<LinkProbeResult> {
  return { link, ...(await probeManifest(link.url, net)) };
}

// Zip URL is the 2.9.1 manifest rule. A dev-worker port is never invented.
export function resolveZipUrl(manifestUrl: string, manifest: unknown): string | null {
  if (!isHttpUrl(manifestUrl) || !manifestUrl.includes(".json")) return null;
  if (!isRecord(manifest) || !isRecord(manifest.metaData) || !isRecord(manifest.metaData.types))
    return null;
  const zipName = manifest.metaData.types.zip;
  if (typeof zipName !== "string" || zipName === "") return null;
  let publicPath: string;
  try {
    publicPath = publicPathOf(manifest.metaData, manifestUrl);
  } catch {
    return null;
  }
  if (publicPath === "") return null;
  const withProtocol = publicPath.startsWith("//") ? `https:${publicPath}` : publicPath;
  const base = withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
  let resolved: URL;
  try {
    resolved = new URL(zipName, base);
  } catch {
    return null;
  }
  if (!isHttpUrl(resolved.href)) return null;
  return resolved.href;
}

async function probeManifest(url: string | null, net: Net): Promise<ArtifactProbe> {
  const blank = emptyArtifact();
  if (!isHttpUrl(url)) return blank;
  let response: Awaited<ReturnType<Net["get"]>>;
  try {
    response = await withTimeout(net.get(url), REQUEST_TIMEOUT_MS);
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout");
    return { ...blank, requestFailure: timeout ? "timeout" : "network" };
  }
  if (!response.ok)
    return {
      ...blank,
      requestFailure: response.status ? `HTTP ${response.status}` : "HTTP error",
    };
  const buildVersion = readBuildVersion(response.json);
  const zipUrl = resolveZipUrl(url, response.json);
  if (!zipUrl) return { ...blank, manifestReachable: true, buildVersion };
  const zip = await callNet(net.get(zipUrl));
  if (!zip?.ok) return { ...blank, manifestReachable: true, buildVersion, zipUrl };
  return {
    manifestReachable: true,
    buildVersion,
    zipUrl,
    zipMtime: finiteMs(zip.lastModified),
    zipHash: zip.body ? sha256(zip.body) : null,
  };
}

function localManifestUrl(port: number, manifestPath: string): string {
  const path = manifestPath.startsWith("/") ? manifestPath : `/${manifestPath}`;
  return `http://127.0.0.1:${port}${path}`;
}

function publicPathOf(meta: Record<string, unknown>, manifestUrl: string): string {
  let publicPath: string;
  if ("publicPath" in meta) {
    publicPath = typeof meta.publicPath === "string" ? meta.publicPath : "";
  } else if (typeof meta.getPublicPath === "string") {
    publicPath = evaluateGetPublicPath(meta.getPublicPath);
  } else {
    return "";
  }
  if (publicPath === "auto")
    return manifestUrl
      .replace(/#.*$/, "")
      .replace(/\?.*$/, "")
      .replace(/\/[^/]+$/, "/");
  return publicPath;
}

function evaluateGetPublicPath(source: string): string {
  const literal =
    /^(?:function\s*\([^)]*\)\s*\{\s*)?return\s+("(?:\\.|[^"\\])*")\s*;?\s*(?:\})?$/.exec(
      source.trim(),
    );
  if (!literal) return "";
  try {
    const value: unknown = JSON.parse(literal[1]);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function readBuildVersion(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.metaData) || !isRecord(json.metaData.buildInfo))
    return null;
  return typeof json.metaData.buildInfo.buildVersion === "string"
    ? json.metaData.buildInfo.buildVersion
    : null;
}

function emptyArtifact(): ArtifactProbe {
  return {
    manifestReachable: false,
    buildVersion: null,
    zipUrl: null,
    zipMtime: null,
    zipHash: null,
  };
}

function emptyResult(portOpen: boolean): ProbeResult {
  return { portOpen, ...emptyArtifact() };
}

function finiteMs(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isHttpUrl(url: string | null): url is string {
  if (url == null) return false;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.includes("${")) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function edgeKey(link: { consumer: string; alias: string; remoteName: string }): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
}

function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function copyInstall(record: InstallConfirmation): InstallConfirmation {
  return { ...record };
}

function copyGeneration(record: GenerationConfirmation): GenerationConfirmation {
  return { ...record, builtDependencyHashes: { ...record.builtDependencyHashes } };
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (month == null || hour > 23 || minute > 59 || second > 59 || day < 1) return null;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return ms;
}

async function callNet<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await withTimeout(work, REQUEST_TIMEOUT_MS);
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
