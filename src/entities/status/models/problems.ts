import type { StatusKind } from "./classify.ts";

export type ProblemSeverity = "warning" | "information";

export type ProblemDraft = {
  file: string;
  message: string;
  severity: ProblemSeverity;
  kind: StatusKind;
};
