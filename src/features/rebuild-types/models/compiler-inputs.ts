export type CompilerRemoteOptions = {
  context?: string;
  compilerInstance?: string;
  implementation?: string;
  generateAPITypes?: boolean;
  afterGenerate?: (info: unknown) => void;
  extractRemoteTypes?: boolean;
  extractThirdParty?: boolean | object;
};

export type CompilerInputs = {
  config: string;
  files: readonly string[];
  writePaths?: () => Promise<{ paths: readonly string[]; declarationTrees: readonly string[] }>;
};
