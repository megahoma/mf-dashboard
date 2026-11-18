import type { Binding } from "@babel/traverse";
import { OPTIONAL_MISS, TAG, UNKNOWN } from "../config/config.ts";
import type { AstPath } from "./syntax.ts";

export type ConfigDirectory = {
  path: string;
  id: string;
  packageMarkers?: readonly (readonly [file: string, present: boolean])[];
  related?: readonly ConfigDirectory[];
};

export type ConfigInput =
  | { file: string; directorySelection: string | null }
  | { file: string; canonical: string; limit: number; directory?: ConfigDirectory }
  | { file: string; packageDirectory: ConfigDirectory }
  | { file: string; resolutionRoot: string }
  | { file: string; packageBoundary: true };

export type LocalApp = {
  name: string;
  folder: string;
  launchFolder?: string;
  configFile: string;
  rslibConfigFile?: string;
  port: number | null;
  manifest: boolean;
  generateTypes: boolean;
  consumeTypes: boolean;
  typesFolder: string;
  tsconfig: string | null;
  manifestPath: string;
  devManifestPath?: string;
  compilerInstance: string | null;
  remotes: { alias: string; name: string; url: string | null }[];
  bundler?: "rslib";
  buildConfigFile?: string;
  generatedZipPath?: string | null;
  configDependencies?: readonly string[];
  configInputs?: readonly ConfigInput[];
  rebuildConfigStamp?: string;
  ownershipSources?: ReadonlySet<string>;
  federationHelpers?: readonly string[];
  federationNameOrigin?: string;
  settingsKey?: string;
  launchEnvironment?: {
    envMode: string;
    env: Readonly<Record<string, string>>;
    allowLocalEnv?: boolean;
    configDirectory?: ConfigDirectory;
  };
  hasExposes?: boolean;
};

export type FunctionValue = {
  [TAG]: "function";
  path: AstPath;
  frame: Map<Binding, Value>;
};

export type MissingTemplate = {
  [TAG]: "missing-template";
  name: string | null;
};

export type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | typeof UNKNOWN
  | typeof OPTIONAL_MISS
  | Value[]
  | ObjectValue
  | FunctionValue
  | MissingTemplate;

export type ObjectValue = { [key: string]: Value; [TAG]?: never };

export type ConfigBundler = "rsbuild" | "rslib" | "vite";

export type ConfigOrigin = { bundler: ConfigBundler; direct: boolean } | null;

export type ConfigContext = {
  mode?: string;
  command?: string;
  bundler?: string;
  preferImportedBundler?: boolean;
  viteBase?: string;
  appDir?: string;
  trackRslibOwnership?: boolean;
  resolveRslibRoot?: (root: Value) => string | null;
  processEnv?: Readonly<Record<string, string>>;
};

export type FederationOwnership = { name: string; origin: string; files: readonly string[] };

export type ConfigCandidate = {
  app: LocalApp | null;
  federationOptions?: ObjectValue;
  federationOwnership?: FederationOwnership;
  bundler?: string;
  importedBundler?: ConfigBundler;
  hasRslibProfile?: boolean;
  port: number | null;
  outputDir: string | null;
  bundlerZipName?: string;
  rsbuildBase?: string;
  viteBase?: string;
  resolveRsbuildDevManifest?: (file: string) => string | undefined;
  manifestFile?: string;
  rsbuildManifestFile?: string;
};
