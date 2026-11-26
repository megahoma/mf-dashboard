export type StatusKind =
  | "checking"
  | "unchecked"
  | "listen"
  | "silent"
  | "unknownPort"
  | "stale"
  | "unfetched"
  | "invalidUrl"
  | "otherHost"
  | "otherPort"
  | "answers"
  | "noAnswer";

export type StatusInput = {
  role: "app" | "link" | "external";
  port: number | null;
  portOpen: boolean;
  checking?: boolean;
  unchecked?: boolean;
  manifestEnabled: boolean;
  buildVersion: string | null;
  url: string | null;
  typesState:
    "none" | "ok" | "stale-source" | "unfetched" | "changed" | "manual" | "unknown" | "unchecked";
  requestFailure?: string | null;
};

export type RowModel = {
  kind: StatusKind;
  description: string;
  tooltip: string;
  urlIssue: string | null;
};
