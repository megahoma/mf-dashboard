import type { DiagnosticDetails } from "../../../shared/models/diagnostic-error-types.ts";
import type { LogContext, LogFields, LogLevel } from "../../../shared/models/logging.ts";

export type EvidenceTask =
  | { kind: "sources"; folder: string; tsconfig: string | null; typesFolder: string }
  | { kind: "contains"; folder: string; tsconfig: string | null; typesFolder: string; file: string }
  | { kind: "installed"; destination: string | null; fresh?: boolean }
  | { kind: "archive"; bytes: Uint8Array; appDir: string };

export type EvidenceReply = {
  value?: unknown;
  events: { level: LogLevel; event: string; fields?: LogFields }[];
  error?: { message: string; code?: string; details?: DiagnosticDetails };
};

export type Pending = {
  task: EvidenceTask;
  log: LogContext;
  queuedAt: number;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
