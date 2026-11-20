import type { TypesStateInput, TypesStatus } from "./state-types.ts";

// consumeTypes is first: a disabled consumer has no stale, unfetched, or type commands.
// A stale source waits out typesSettleMs. Until then the save does not change the status.
export function typesState(input: TypesStateInput): TypesStatus {
  if (!input.consumeTypes) return "none";
  const settled =
    input.sourceSavedAt != null && input.checkedAt - input.sourceSavedAt >= input.typesSettleMs;
  if (input.generateTypes && input.sourceFreshness === "stale" && settled) return "stale-source";
  if (input.installedChanged) return "changed";
  if ((!input.folderExists && input.zipReachable) || input.installedFreshness === "stale")
    return "unfetched";
  if (!input.generateTypes) return input.installedFreshness === "fresh" ? "ok" : "manual";
  if (input.sourceFreshness === "unknown" || input.installedFreshness === "unknown")
    return "unknown";
  if (input.installedFreshness === "fresh") return "ok";
  return "unknown";
}
