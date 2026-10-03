import net from "node:net";
import {
  createProbeCycle,
  httpDateMs,
  type Net,
  type ProbeBook,
  type ProbeCycleInput,
} from "./probe.ts";
import { readLimitedBody } from "../../shared/http-body.ts";

const CONNECT_TIMEOUT_MS = 500;

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
    async get(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const lastModified = httpDateMs(response.headers.get("last-modified"));
      if (!response.ok)
        return { ok: false, status: response.status, json: null, body: null, lastModified };
      const body = await readLimitedBody(response);
      let json: unknown = null;
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("json") || url.includes(".json")) {
        try {
          json = JSON.parse(new TextDecoder().decode(body)) as unknown;
        } catch {
          json = null;
        }
      }
      return { ok: true, json, body, lastModified };
    },
  };
}

export async function probeWorkspace(book: ProbeBook, input: ProbeCycleInput): Promise<void> {
  await createProbeCycle(createLoopbackNet(), book).start(input);
}
