export type StatusKind =
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
};
