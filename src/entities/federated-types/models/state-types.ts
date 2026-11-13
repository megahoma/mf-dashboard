export type TypesStateInput = {
  generateTypes: boolean;
  consumeTypes: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  installedFreshness: "fresh" | "stale" | "unknown";
  installedChanged?: boolean;
  zipReachable: boolean;
  folderExists: boolean;
  sourceSavedAt: number | null;
  checkedAt: number;
  typesSettleMs: number;
};

export type TypesStatus =
  "none" | "ok" | "stale-source" | "unfetched" | "changed" | "manual" | "unknown" | "unchecked";
