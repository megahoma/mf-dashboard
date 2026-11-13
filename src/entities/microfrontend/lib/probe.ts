import { noLog } from "../../../shared/config/logging.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import { localManifestUrl } from "../../../shared/lib/urls.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { LocalApp } from "../models/config.ts";
import type {
  ArtifactProbe,
  LinkProbeResult,
  Net,
  ProbeBook,
  ProbeCycleInput,
  ProbeResult,
  RemoteLink,
  RequestQueue,
  ZipCache,
} from "../models/probe.ts";
import { appsByName } from "./app-links.ts";
import { linkProbeId, putAppResult, putExternalResult, putLinkResults } from "./probe-book.ts";
import { emptyArtifact, probeManifest } from "./probe-manifest.ts";
import { callNet, createRequestQueue } from "./probe-request.ts";

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
        const local = appsByName(input.apps);
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
            logDuration(log, "probe.completed", started, {
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

function emptyResult(portOpen: boolean): ProbeResult {
  return { portOpen, ...emptyArtifact() };
}
