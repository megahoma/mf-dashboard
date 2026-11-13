import { noLog } from "../../../shared/config/logging.ts";
import { isTimeoutError } from "../../../shared/lib/errors.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import { isRecord } from "../../../shared/lib/record.ts";
import { isHttpUrl } from "../../../shared/lib/urls.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { ArtifactProbe, Net, ZipCache } from "../models/probe.ts";
import { readManifestModules } from "./manifest-modules.ts";
import { request } from "./probe-request.ts";
import { probeZip } from "./probe-zip.ts";

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

export async function probeManifest(
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
    response = await request(() => net.get(url), cache, { kind: "manifest", url });
  } catch (error) {
    const timeout = isTimeoutError(error);
    logDuration(
      log,
      "manifest.failed",
      started,
      {
        url,
        reason: timeout ? "timeout" : "network",
        ...safeError(error),
      },
      "trace",
    );
    return { ...blank, requestFailure: timeout ? "timeout" : "network" };
  }
  logDuration(
    log,
    "manifest.response",
    started,
    {
      url,
      status: response.status,
      ok: response.ok,
      validJson: response.json != null,
    },
    "trace",
  );
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

export function emptyArtifact(): ArtifactProbe {
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
