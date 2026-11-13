export type ManifestShared = {
  name: string;
  version: string | null;
  singleton: boolean;
};

export type ManifestModules = {
  exposes: string[];
  shared: ManifestShared[];
};

export type ManifestLineTerms = {
  exposes: string;
  shared: string;
  singleton: string;
};
