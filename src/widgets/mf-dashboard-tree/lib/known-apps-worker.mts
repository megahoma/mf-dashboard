import path from "node:path";
import { Worker } from "node:worker_threads";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { createSerialQueue } from "../../../shared/lib/queue.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type {
  ConfigWorkerReply,
  ConfigWorkerTasks,
  KnownAppsResult,
  KnownAppsTask,
} from "../models/session-types.ts";

type ConfigResult = ConfigWorkerTasks[keyof ConfigWorkerTasks]["result"];

export class KnownAppsWorker {
  private worker?: Worker;
  private readonly queue = createSerialQueue();
  private pending?: {
    log: LogContext;
    resolve(result: ConfigResult): void;
    reject(error: Error): void;
  };
  private disposed = false;

  load(task: KnownAppsTask, log: LogContext): Promise<KnownAppsResult> {
    return this.request("load", task, log);
  }

  request<K extends keyof ConfigWorkerTasks>(
    kind: K,
    input: ConfigWorkerTasks[K]["input"],
    log: LogContext,
  ): Promise<ConfigWorkerTasks[K]["result"]> {
    return this.queue(() => this.run(kind, input, log));
  }

  private run<K extends keyof ConfigWorkerTasks>(
    kind: K,
    input: ConfigWorkerTasks[K]["input"],
    log: LogContext,
  ): Promise<ConfigWorkerTasks[K]["result"]> {
    if (this.disposed) return Promise.reject(new Error("Known apps worker disposed"));
    return new Promise((resolve, reject) => {
      this.pending = {
        log,
        resolve: (result) => resolve(result as ConfigWorkerTasks[K]["result"]),
        reject,
      };
      try {
        const worker = this.worker ?? this.start();
        worker.ref();
        const levels = ["trace", "debug", "info", "warn", "error"] as const;
        worker.postMessage({
          kind,
          input,
          logLevels: levels.filter((level) => log.enabled?.(level) ?? true),
        });
      } catch (error) {
        this.stop(error);
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.stop(new Error("Known apps worker disposed"));
  }

  private start(): Worker {
    const location =
      typeof __dirname === "string"
        ? path.join(__dirname, "known-apps-worker.js")
        : new URL("../known-apps-worker.ts", import.meta.url);
    const worker = new Worker(location);
    this.worker = worker;
    worker.on("message", (reply: ConfigWorkerReply) => {
      if (this.worker !== worker || !this.pending) return;
      const pending = this.pending;
      this.pending = undefined;
      worker.unref();
      try {
        for (const { level, event, fields } of reply.events)
          pending.log.event(level, event, fields);
        if ("error" in reply) pending.reject(new Error(reply.error));
        else pending.resolve(reply.result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.stop(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.stop(new Error(`Known apps worker exited (${code})`));
    });
    return worker;
  }

  private stop(error: unknown) {
    const worker = this.worker;
    this.worker = undefined;
    this.pending?.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    this.pending = undefined;
    void worker?.terminate();
  }
}
