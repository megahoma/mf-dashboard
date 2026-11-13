import { noLog } from "../../../shared/config/logging.ts";
import { isTimeoutError } from "../../../shared/lib/errors.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import type { Net, ZipCache, ZipProbe } from "../models/probe.ts";
import { finiteMs, request } from "./probe-request.ts";

export function probeZip(url: string, net: Net, cache?: ZipCache): Promise<ZipProbe | null> {
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
      { kind: "zip", url },
    );
  } catch (error) {
    logDuration(
      cache?.log ?? noLog,
      "zip.failed",
      started,
      {
        url,
        reason: isTimeoutError(error) ? "timeout" : "network",
        ...safeError(error),
      },
      "trace",
    );
    return null;
  }
  logDuration(
    cache?.log ?? noLog,
    "zip.response",
    started,
    {
      url,
      status: zip?.status,
      ok: zip?.ok ?? false,
      bytes: zip?.body?.byteLength ?? 0,
    },
    "trace",
  );
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
