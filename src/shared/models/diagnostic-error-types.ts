import { REASONS, STAGES } from "../config/diagnostic-error.ts";

export type DiagnosticDetails = {
  stage: (typeof STAGES)[number];
  reason: (typeof REASONS)[number];
  status?: number;
  timeoutMs?: number;
  exitCode?: number;
};
