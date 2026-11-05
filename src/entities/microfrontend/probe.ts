import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import { localManifestUrl, isHttpUrl } from "../../shared/urls.ts";
import { createHash } from "node:crypto";
import type { LocalApp } from "./discover.ts";
import { readManifestModules, type ManifestShared } from "./manifest-modules.ts";

// Manifest requests in the proved 2.9.1 path use a 10s timeout.
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_CONCURRENCY = 8;

export interface Net {
  connect(port: number): Promise<boolean>;
  get(
    url: string,
    init?: { ifModifiedSince?: number },
  ): Promise<{
    ok: boolean;
    status?: number;
    json: unknown | null;
    body: Uint8Array | null;
    lastModified: number | null;
    notModified?: boolean;
  }>;
}

export interface ArtifactProbe {
  manifestReachable: boolean;
  requestFailure?: "timeout" | "network" | `HTTP ${number}` | "HTTP error";
  buildVersion: string | null;
  zipUrl: string | null;
  zipMtime: number | null;
  zipHash: string | null;
  exposes: string[];
  shared: ManifestShared[];
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
  zips: Map<string, ZipFact>;
}

export interface ZipFact {
  zipMtime: number | null;
  zipHash: string;
}

export interface ProbeCycleInput {
  apps: readonly LocalApp[];
  links: readonly RemoteLink[];
  extraManifestUrls: readonly string[];
  log?: LogContext;
  checkTypes?: boolean;
  typeLinks?: ReadonlySet<string>;
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
  return { apps: new Map(), links: new Map(), extras: new Map(), zips: new Map() };
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

function putLinkResults(book: ProbeBook, results: readonly LinkProbeResult[]): void {
  if (results.length === 0) return;
  const currentIds = new Map<string, string>();
  // Preserve matching IDs' insertion positions just like standalone writes.
  for (const { link } of results) {
    const edge = edgeKey(link);
    if (!currentIds.has(edge)) currentIds.set(edge, linkProbeId(link));
  }
  for (const [id, stored] of book.links) {
    const nextId = currentIds.get(edgeKey(stored.link));
    if (nextId !== undefined && id !== nextId) book.links.delete(id);
  }
  for (const result of results) {
    const edge = edgeKey(result.link);
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

export function createProbeCycle(
  net: Net,
  book: ProbeBook,
): { start(input: ProbeCycleInput): Promise<boolean> } {
  let inflight: Promise<void> | null = null;
  return {
    start(input) {
      if (inflight) return Promise.resolve(false);
      const log = input.log ?? noLog;
      const started = Date.now();
      const cache: ZipCache = {
        book,
        cycle: new Map(),
        pendingZips: new Map(),
        manifests: new Map(),
        request: createRequestQueue(),
        seen: new Set(),
        log,
        manifestRequests: 0,
        zipRequests: 0,
      };
      const checkTypes = input.checkTypes !== false;
      const producers = input.typeLinks
        ? new Set(
            input.links
              .filter((link) => input.typeLinks!.has(linkProbeId(link)))
              .map((link) => link.remoteName),
          )
        : null;
      if (producers) {
        const local = new Map(input.apps.map((app) => [app.name, app]));
        // Generation confirmations include the producer's direct local dependency hashes.
        for (const name of [...producers]) {
          const producer = local.get(name);
          if (!producer?.generateTypes) continue;
          for (const remote of producer.remotes)
            if (local.get(remote.name)?.generateTypes) producers.add(remote.name);
        }
      }
      const manifest = (url: string | null, types = checkTypes) =>
        probeManifest(url, net, cache, log, types);
      log.event("debug", "probe.started", {
        apps: input.apps.length,
        links: input.links.length,
        extras: input.extraManifestUrls.length,
      });
      const run = (async () => {
        const [apps, links, extras] = await Promise.all([
          Promise.all(
            input.apps.map((app) =>
              probeConnectedApp(
                app,
                net,
                (url) =>
                  manifest(url, checkTypes && (producers == null || producers.has(app.name))),
                log,
                cache.request,
              ),
            ),
          ),
          Promise.all(
            input.links.map((link) =>
              manifest(
                link.url,
                checkTypes && (!input.typeLinks || input.typeLinks.has(linkProbeId(link))),
              ),
            ),
          ),
          Promise.all(
            input.extraManifestUrls.map((url) => manifest(url, checkTypes && !input.typeLinks)),
          ),
        ]);
        input.apps.forEach((app, index) => putAppResult(book, app.name, apps[index]));
        putLinkResults(
          book,
          input.links.map((link, index) => ({ link, ...links[index] })),
        );
        input.extraManifestUrls.forEach((url, index) =>
          putExternalResult(book, url, extras[index]),
        );
        if (checkTypes && !input.typeLinks)
          for (const url of book.zips.keys()) {
            if (!cache.seen.has(url)) book.zips.delete(url);
          }
      })();
      inflight = run
        .then(
          () => {
            log.event("debug", "probe.completed", {
              durationMs: Date.now() - started,
              manifestRequests: cache.manifestRequests,
              zipRequests: cache.zipRequests,
            });
          },
          (error: unknown) => {
            log.event("debug", "probe.failed", safeError(error));
            throw error;
          },
        )
        .finally(() => {
          inflight = null;
        });
      return inflight.then(() => true);
    },
  };
}

// connect(port) is a loopback check on 127.0.0.1. The host is not a remote URL.
export async function probeApp(app: LocalApp, net: Net): Promise<ProbeResult> {
  return probeConnectedApp(app, net, (url) => probeManifest(url, net));
}

async function probeConnectedApp(
  app: LocalApp,
  net: Net,
  manifest: (url: string) => Promise<ArtifactProbe>,
  log: LogContext = noLog,
  request: RequestQueue = (work) => work(),
): Promise<ProbeResult> {
  if (app.port == null) return emptyResult(false);
  const started = Date.now();
  const port = app.port;
  const opened = await request(() => callNet(net.connect(port)));
  log.event("trace", "port.checked", {
    app: app.name,
    port: app.port,
    open: opened === true,
    durationMs: Date.now() - started,
  });
  const portOpen = opened === true;
  if (!portOpen || !app.manifest) return emptyResult(portOpen);
  return { portOpen, ...(await manifest(localManifestUrl(app.port, app.manifestPath))) };
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

type ZipProbe = Pick<ArtifactProbe, "zipMtime" | "zipHash">;
type RequestQueue = <T>(work: () => Promise<T>) => Promise<T>;

function createRequestQueue(): RequestQueue {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (active >= REQUEST_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function request<T>(work: () => Promise<T>, cache?: ZipCache): Promise<T> {
  const timed = () => withTimeout(work(), REQUEST_TIMEOUT_MS);
  return cache ? cache.request(timed) : timed();
}

interface ZipCache {
  book: ProbeBook;
  cycle: Map<string, ZipFact>;
  pendingZips: Map<string, Promise<ZipProbe | null>>;
  manifests: Map<string, Promise<ArtifactProbe>>;
  request: RequestQueue;
  seen: Set<string>;
  log: LogContext;
  manifestRequests: number;
  zipRequests: number;
}

function probeZip(url: string, net: Net, cache?: ZipCache): Promise<ZipProbe | null> {
  cache?.seen.add(url);
  const cached = cache?.cycle.get(url);
  if (cached) {
    cache?.log.event("trace", "zip.reused", { url, reason: "cycle-cache" });
    return Promise.resolve(cached);
  }
  const pending = cache?.pendingZips.get(url);
  if (pending) {
    cache?.log.event("trace", "zip.reused", { url, reason: "cycle-inflight" });
    return pending;
  }
  const work = requestZip(url, net, cache).finally(() => cache?.pendingZips.delete(url));
  cache?.pendingZips.set(url, work);
  return work;
}

async function requestZip(url: string, net: Net, cache?: ZipCache): Promise<ZipProbe | null> {
  const previous = cache?.book.zips.get(url);
  const started = Date.now();
  cache?.log.event("trace", "zip.request", { url, conditional: previous?.zipMtime != null });
  if (cache) cache.zipRequests++;
  let zip: Awaited<ReturnType<Net["get"]>>;
  try {
    zip = await request(
      () =>
        net.get(
          url,
          previous?.zipMtime != null ? { ifModifiedSince: previous.zipMtime } : undefined,
        ),
      cache,
    );
  } catch (error) {
    cache?.log.event("trace", "zip.failed", {
      url,
      reason:
        error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout")
          ? "timeout"
          : "network",
      durationMs: Date.now() - started,
      ...safeError(error),
    });
    return null;
  }
  cache?.log.event("trace", "zip.response", {
    url,
    status: zip?.status,
    ok: zip?.ok ?? false,
    bytes: zip?.body?.byteLength ?? 0,
    durationMs: Date.now() - started,
  });
  if (zip?.notModified || zip?.status === 304) {
    if (!previous || previous.zipMtime == null) {
      cache?.log.event("trace", "zip.skipped", { url, reason: "304-without-prior-hash" });
      return null;
    }
    cache?.log.event("trace", "zip.reused", { url, reason: "not-modified", reusedHash: true });
    cache?.cycle.set(url, previous);
    return previous;
  }
  if (!zip?.ok) return null;
  const fact = {
    zipMtime: finiteMs(zip.lastModified),
    zipHash: zip.body ? sha256(zip.body) : null,
  };
  if (fact.zipHash != null) {
    const saved = { ...fact, zipHash: fact.zipHash };
    cache?.cycle.set(url, saved);
    cache?.book.zips.set(url, saved);
  }
  return fact;
}

async function probeManifest(
  url: string | null,
  net: Net,
  cache?: ZipCache,
  log: LogContext = noLog,
  checkTypes = true,
): Promise<ArtifactProbe> {
  let pending = url == null ? undefined : cache?.manifests.get(url);
  if (!pending) {
    pending = requestManifest(url, net, cache, log);
    if (url != null) cache?.manifests.set(url, pending);
  }
  const manifest = await pending;
  if (!checkTypes || !manifest.zipUrl) return manifest;
  const zip = await probeZip(manifest.zipUrl, net, cache);
  return zip ? { ...manifest, ...zip } : manifest;
}

async function requestManifest(
  url: string | null,
  net: Net,
  cache: ZipCache | undefined,
  log: LogContext,
): Promise<ArtifactProbe> {
  const blank = emptyArtifact();
  if (!isHttpUrl(url)) {
    log.event("trace", "manifest.skipped", { reason: "invalid-url" });
    return blank;
  }
  const started = Date.now();
  log.event("trace", "manifest.request", { url });
  let response: Awaited<ReturnType<Net["get"]>>;
  try {
    if (cache) cache.manifestRequests++;
    response = await request(() => net.get(url), cache);
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout");
    log.event("trace", "manifest.failed", {
      url,
      reason: timeout ? "timeout" : "network",
      durationMs: Date.now() - started,
      ...safeError(error),
    });
    return { ...blank, requestFailure: timeout ? "timeout" : "network" };
  }
  log.event("trace", "manifest.response", {
    url,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - started,
    validJson: response.json != null,
  });
  if (!response.ok)
    return {
      ...blank,
      requestFailure: response.status ? `HTTP ${response.status}` : "HTTP error",
    };
  const buildVersion = readBuildVersion(response.json);
  const modules = readManifestModules(response.json);
  const zipUrl = resolveZipUrl(url, response.json);
  if (!zipUrl) {
    log.event("trace", "zip.skipped", {
      url,
      reason: response.json == null ? "invalid-json" : "missing-or-invalid-types-metadata",
    });
    return { ...blank, manifestReachable: true, buildVersion, ...modules };
  }
  return { ...blank, manifestReachable: true, buildVersion, zipUrl, ...modules };
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
    exposes: [],
    shared: [],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function edgeKey(link: { consumer: string; alias: string; remoteName: string }): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
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
