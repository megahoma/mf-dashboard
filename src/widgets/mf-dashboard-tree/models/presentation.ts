import type { LocalApp, ProbeBook, RemoteLink } from "../../../entities/microfrontend/index.ts";
import type { StatusInput, StatusKind } from "../../../entities/status/index.ts";
import type { DashboardTerms } from "../../../shared/config/index.ts";
import type { RowAction } from "./targets.ts";

export type DashboardStructure = "flat" | "tree";
export type DashboardSort = "name" | "port";

export type DashboardNode = {
  id: string;
  name: string;
  kind: StatusKind;
  description: string;
  tooltip: string;
  manifest?: {
    url: string | null;
    status: "answers" | "noAnswer" | "checking" | "unchecked";
    label: string;
  };
  contextValue: string;
  children: DashboardNode[];
  linkId: string | null;
};

export type DashboardView = {
  readonly loaded: readonly LocalApp[];
  readonly extraUrls: readonly string[];
  readonly structure: DashboardStructure;
  readonly flatSort: DashboardSort;
  readonly terms: DashboardTerms;
  readonly book: ProbeBook;
  readonly probeRunning?: boolean;
  readonly manualProbeOnly?: boolean;
  readonly pending: ReadonlySet<string>;
  readonly refetchErrors: ReadonlySet<string>;
  readonly scriptGaps: ReadonlySet<string>;
  readonly rebuildErrors: ReadonlyMap<string, string>;
  typesForLink(link: RemoteLink): StatusInput["typesState"];
  actionFor(node: unknown): RowAction | null;
};
