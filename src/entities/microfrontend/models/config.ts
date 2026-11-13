import type { Binding } from "@babel/traverse";
import { OPTIONAL_MISS, TAG, UNKNOWN } from "../config/config.ts";
import type { AstPath } from "./syntax.ts";

export type LocalApp = {
  name: string;
  folder: string;
  configFile: string;
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
  buildConfigFile?: string;
  generatedZipPath?: string | null;
  configDependencies?: readonly string[];
  settingsKey?: string;
  launchEnvironment?: { envMode: string; env: Readonly<Record<string, string>> };
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

export type ConfigBundler = "rsbuild" | "vite";

export type ConfigOrigin = { bundler: ConfigBundler; direct: boolean } | null;

export type ConfigContext = {
  mode?: string;
  command?: string;
  bundler?: string;
  preferImportedBundler?: boolean;
  appDir?: string;
  processEnv?: Readonly<Record<string, string>>;
};

export type ConfigCandidate = {
  app: LocalApp | null;
  bundler?: string;
  importedBundler?: ConfigBundler;
  port: number | null;
  outputDir: string | null;
  bundlerZipName?: string;
  rsbuildBase?: string;
  resolveRsbuildDevManifest?: (file: string) => string | undefined;
  rsbuildManifestFile?: string;
};
