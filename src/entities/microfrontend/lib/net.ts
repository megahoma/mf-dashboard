import net from "node:net";
import { HTTP_CHECK_TIMEOUT_MS } from "../../../shared/config/http-body.ts";
import { decodeJsonBody, readLimitedBody } from "../../../shared/lib/http-body.ts";
import { CONNECT_TIMEOUT_MS } from "../config/net.ts";
import type { Net, ProbeBook, ProbeCycleInput } from "../models/probe.ts";
import { httpDateMs } from "./http-date.ts";
import { createProbeCycle } from "./probe.ts";

export function createLoopbackNet(): Net {
  return {
    connect(port) {
      return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        let settled = false;
        const finish = (open: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(open);
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
      });
    },
    async get(url, init) {
      const signal = AbortSignal.timeout(HTTP_CHECK_TIMEOUT_MS);
      let response = await fetch(url, {
        signal,
        headers: init?.ifNoneMatch
          ? { "If-None-Match": init.ifNoneMatch }
          : init?.ifModifiedSince != null
            ? { "If-Modified-Since": new Date(init.ifModifiedSince).toUTCString() }
            : undefined,
      });
      // A redirect can point to a different resource with the same validator.
      if (init?.ifNoneMatch && response.redirected && response.status === 304)
        response = await fetch(url, { signal });
      const lastModified = httpDateMs(response.headers.get("last-modified"));
      if (response.status === 304)
        return { ok: true, status: 304, notModified: true, json: null, body: null, lastModified };
      if (!response.ok)
        return { ok: false, status: response.status, json: null, body: null, lastModified };
      const body = await readLimitedBody(response);
      let json: unknown = null;
      const type = response.headers.get("content-type") ?? "";
      if (init?.parseJson || type.includes("json") || url.includes(".json")) {
        try {
          json = decodeJsonBody(body);
        } catch {
          json = null;
        }
      }
      const etag = response.redirected ? null : response.headers.get("etag");
      return { ok: true, status: response.status, json, body, lastModified, ...(etag && { etag }) };
    },
  };
}

export async function probeWorkspace(book: ProbeBook, input: ProbeCycleInput): Promise<void> {
  await createProbeCycle(createLoopbackNet(), book).start(input);
}
