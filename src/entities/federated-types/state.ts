export interface TypesStateInput {
  generateTypes: boolean;
  consumeTypes: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  installedFreshness: "fresh" | "stale" | "unknown";
  zipReachable: boolean;
  folderExists: boolean;
  sourceSavedAt: number | null;
  checkedAt: number;
  typesSettleMs: number;
}

export type TypesStatus = "none" | "ok" | "stale-source" | "unfetched" | "manual" | "unknown";

// consumeTypes is first: a disabled consumer has no stale, unfetched, or type commands.
// A stale source waits out typesSettleMs. Until then the save does not change the status.
export function typesState(input: TypesStateInput): TypesStatus {
  if (!input.consumeTypes) return "none";
  if (!input.generateTypes) return "manual";
  const settled =
    input.sourceSavedAt != null && input.checkedAt - input.sourceSavedAt >= input.typesSettleMs;
  if (input.sourceFreshness === "stale" && settled) return "stale-source";
  if ((!input.folderExists && input.zipReachable) || input.installedFreshness === "stale")
    return "unfetched";
  if (input.sourceFreshness === "unknown" || input.installedFreshness === "unknown")
    return "unknown";
  if (input.installedFreshness === "fresh") return "ok";
  return "unknown";
}
