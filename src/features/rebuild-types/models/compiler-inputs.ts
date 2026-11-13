export type CompilerRemoteOptions = {
  context?: string;
  compilerInstance?: string;
  implementation?: string;
  generateAPITypes?: boolean;
  extractRemoteTypes?: boolean;
  extractThirdParty?: boolean | object;
};

export type CompilerInputs = {
  config: string;
  files: readonly string[];
};
