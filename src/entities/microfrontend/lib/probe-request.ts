import type { LogFields } from "../../../shared/models/logging.ts";
import { REQUEST_CONCURRENCY, REQUEST_TIMEOUT_MS } from "../config/probe.ts";
import type { RequestQueue, ZipCache } from "../models/probe.ts";

export function createRequestQueue(): RequestQueue {
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

export function request<T>(
  work: () => Promise<T>,
  cache?: ZipCache,
  fields: LogFields = {},
): Promise<T> {
  const queued = Date.now();
  const timed = () => {
    const queueMs = Date.now() - queued;
    cache?.log.event(queueMs >= 1000 ? "warn" : "trace", "request.started", { ...fields, queueMs });
    return withTimeout(work(), REQUEST_TIMEOUT_MS);
  };
  return cache ? cache.request(timed) : timed();
}

export function finiteMs(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function callNet<T>(work: Promise<T>): Promise<T | null> {
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
