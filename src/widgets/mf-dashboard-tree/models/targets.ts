import type { LocalApp } from "../../../entities/microfrontend/index.ts";

export type TypesDirectoryLookup = (app: LocalApp, alias?: string) => string | null;

export type RowActionInput = {
  configFile: string | null;
  producerConfigFile: string | null;
  typesDir: string | null;
  manifestUrl: string | null;
};

export type RowAction = RowActionInput & { tokens: string[] };
