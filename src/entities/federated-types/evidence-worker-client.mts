import { Worker } from "node:worker_threads";
import path from "node:path";
import { DiagnosticError, type DiagnosticDetails } from "../../shared/diagnostic-error.ts";
import {
  logDuration,
  noLog,
  type LogContext,
  type LogFields,
  type LogLevel,
} from "../../shared/logging.ts";
import type { SourceIdentity } from "./sources.ts";
import type { InstalledEvidence } from "./observe.ts";

export type EvidenceTask =
  | { kind: "sources"; folder: string; tsconfig: string | null; typesFolder: string }
  | { kind: "contains"; folder: string; tsconfig: string | null; typesFolder: string; file: string }
  | { kind: "installed"; destination: string | null; fresh?: boolean }
  | { kind: "archive"; bytes: Uint8Array; appDir: string };

export interface EvidenceReply {
  value?: unknown;
  events: { level: LogLevel; event: string; fields?: LogFields }[];
  error?: { message: string; code?: string; details?: DiagnosticDetails };
}

interface Pending {
  task: EvidenceTask;
  log: LogContext;
  queuedAt: number;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

let worker: Worker | undefined;
let active: Pending | undefined;
const pending: Pending[] = [];

function fail(error: Error): void {
  const failed = worker;
  worker = undefined;
  active?.reject(error);
  active = undefined;
  for (const item of pending.splice(0)) item.reject(error);
  void failed?.terminate();
}

function drain(): void {
  if (active || !pending.length) return;
  if (!worker) {
    // The extension bundle and its worker are siblings; source tests run the TS entry directly.
    const location =
      typeof __dirname === "string"
        ? path.join(__dirname, "evidence-worker.js")
        : new URL("./evidence-worker.ts", import.meta.url);
    const current = new Worker(location);
    worker = current;
    current.on("message", (reply: EvidenceReply) => {
      if (worker !== current || !active) return;
      const item = active;
      active = undefined;
      for (const entry of reply.events) item.log.event(entry.level, entry.event, entry.fields);
      logDuration(item.log, "evidence.task.finished", item.startedAt, {
        task: item.task.kind,
        path:
          "folder" in item.task
            ? item.task.folder
            : "destination" in item.task
              ? item.task.destination
              : item.task.appDir,
        queueMs: item.startedAt - item.queuedAt,
        failed: reply.error != null,
      });
      if (reply.error) {
        const error = reply.error.details
          ? new DiagnosticError(reply.error.message, reply.error.details)
          : new Error(reply.error.message);
        if (reply.error.code) Object.assign(error, { code: reply.error.code });
        item.reject(error);
      } else item.resolve(reply.value);
      current.unref();
      drain();
    });
    current.on("error", (error) => {
      if (worker === current) fail(error instanceof Error ? error : new Error(String(error)));
    });
    current.on("exit", (code) => {
      if (worker === current) fail(new Error(`Evidence worker exited (${code})`));
    });
  }
  active = pending.shift()!;
  active.startedAt = Date.now();
  worker.ref();
  worker.postMessage(active.task);
}

export function runEvidenceTask<T>(task: EvidenceTask, log: LogContext = noLog): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.push({
      task,
      log,
      queuedAt: Date.now(),
      startedAt: 0,
      resolve: (value) => resolve(value as T),
      reject,
    });
    try {
      drain();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function disposeEvidenceWorker(): void {
  fail(new Error("Evidence worker disposed"));
}

export function sourceIdentityAsync(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  log: LogContext = noLog,
): Promise<SourceIdentity> {
  return runEvidenceTask({ kind: "sources", folder, tsconfig, typesFolder }, log);
}

export function sourceContainsAsync(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  file: string,
): Promise<boolean> {
  return runEvidenceTask({ kind: "contains", folder, tsconfig, typesFolder, file });
}

export function readInstalledEvidenceAsync(
  destination: string | null,
  log: LogContext = noLog,
  fresh = false,
): Promise<InstalledEvidence> {
  return runEvidenceTask({ kind: "installed", destination, fresh }, log);
}
