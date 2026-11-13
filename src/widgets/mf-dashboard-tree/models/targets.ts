export type RowActionInput = {
  configFile: string | null;
  producerConfigFile: string | null;
  typesDir: string | null;
  manifestUrl: string | null;
};

export type RowAction = RowActionInput & { tokens: string[] };
