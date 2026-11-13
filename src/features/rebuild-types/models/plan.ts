import type { LocalApp } from "../../../entities/microfrontend/index.ts";

export type ChainNode = {
  name: string;
  dependencies: string[];
  zipMtime: number | null;
  sourceSavedAt: number | null;
  zipReachable: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  zipHash?: string | null;
  builtDependencyHashes?: Record<string, string>;
};

export type PlannedStep = {
  name: string;
  action: "rebuild" | "skip";
};

export type WorkspaceTypesNode = {
  app: LocalApp;
  generate: boolean;
  links: { remote: LocalApp["remotes"][number]; url: URL | null; producer?: string }[];
  dependencies: string[];
};
