import type { LocalApp, ProbeBook, RemoteLink } from "../../../entities/microfrontend/index.ts";
import type { StatusInput, StatusKind } from "../../../entities/status/index.ts";
import type { DashboardTerms } from "../../../shared/config/index.ts";
import type { RowAction } from "./targets.ts";

export type DashboardStructure = "flat" | "tree";

export type DashboardNode = {
  id: string;
  name: string;
  kind: StatusKind;
  description: string;
  tooltip: string;
  contextValue: string;
  children: DashboardNode[];
  linkId: string | null;
};

export type DashboardView = {
  readonly loaded: readonly LocalApp[];
  readonly extraUrls: readonly string[];
  readonly structure: DashboardStructure;
  readonly terms: DashboardTerms;
  readonly book: ProbeBook;
  readonly pending: ReadonlySet<string>;
  readonly refetchErrors: ReadonlySet<string>;
  readonly scriptGaps: ReadonlySet<string>;
  readonly rebuildErrors: ReadonlyMap<string, string>;
  typesForLink(link: RemoteLink): StatusInput["typesState"];
  readonly typesAutoCheck?: boolean;
  typesCheckedAt?(link: RemoteLink): number | null;
  actionFor(node: unknown): RowAction | null;
};
