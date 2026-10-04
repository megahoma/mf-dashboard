const STAGES = ["manifest", "archive", "shell", "destination"] as const;
const REASONS = [
  "http-status",
  "timeout",
  "network",
  "invalid-manifest-url",
  "invalid-json",
  "missing-types-metadata",
  "invalid-zip",
  "archive-invalid",
  "directory-missing",
  "directory-empty",
  "fingerprint-mismatch",
  "unsafe-alias",
  "unsafe-types-folder",
  "path-escape",
  "shell-exit",
] as const;

export interface DiagnosticDetails {
  stage: (typeof STAGES)[number];
  reason: (typeof REASONS)[number];
  status?: number;
  timeoutMs?: number;
  exitCode?: number;
}

// Only errors created by this module carry structured diagnostic context.
export class DiagnosticError extends Error {
  readonly details: Readonly<DiagnosticDetails>;

  constructor(message: string, details: DiagnosticDetails, options?: ErrorOptions) {
    super(message, options);
    this.details = Object.freeze({
      stage: details.stage,
      reason: details.reason,
      status: details.status,
      timeoutMs: details.timeoutMs,
      exitCode: details.exitCode,
    });
  }
}

export function diagnosticFields(error: unknown): Partial<DiagnosticDetails> {
  if (!(error instanceof DiagnosticError)) return {};
  const { stage, reason, status, timeoutMs, exitCode } = error.details;
  return {
    stage: STAGES.includes(stage) ? stage : undefined,
    reason: REASONS.includes(reason) ? reason : undefined,
    status:
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined,
    timeoutMs:
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? timeoutMs
        : undefined,
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : undefined,
  };
}
