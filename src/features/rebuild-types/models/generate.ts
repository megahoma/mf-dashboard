import type { ConfigDirectory } from "../../../entities/microfrontend/index.ts";
import type { DiagnosticDetails } from "../../../shared/models/diagnostic-error-types.ts";
import type { SourceProblem } from "../../../shared/models/source-problem.ts";
import { cliDefaults } from "../config/generate.ts";
import type { CompilerRemoteOptions } from "./compiler-inputs.ts";

type GeneratedDts = {
  typesFolder?: string;
  outputDir?: string;
  tsConfigPath?: string;
  compilerInstance?: string;
  abortOnError?: boolean;
  compileInChildProcess?: boolean;
  extractRemoteTypes?: boolean;
  afterGenerate?: (info: unknown) => void;
};

type DtsOptions = {
  cwd?: string;
  tsConfigPath?: string;
  generateTypes?: boolean | GeneratedDts;
  consumeTypes?: boolean | { typesFolder?: string };
};

export type MfOptions = {
  name?: string;
  exposes?: Record<string, string>;
  remotes?: Record<string, string>;
  dts?: boolean | DtsOptions;
};

type RsbuildConfig = {
  plugins?: unknown[];
  server?: { port?: number };
  devServer?: { port?: number };
  output?: { distPath?: { root?: string } };
};

export type RsbuildConfigExport =
  | RsbuildConfig
  | ((params: {
      command: "build";
      env: string;
      envMode: string;
    }) => RsbuildConfig | Promise<RsbuildConfig>);

export type DtsApi = {
  isTSProject: (dts: unknown, context: string) => boolean;
  normalizeDtsOptions: (
    options: MfOptions,
    context: string,
    defaults: typeof cliDefaults,
  ) => DtsOptions | false;
  normalizeGenerateTypesOptions: (input: {
    context: string;
    outputDir: string;
    dtsOptions: DtsOptions;
    pluginOptions: MfOptions;
  }) => { remote?: CompilerRemoteOptions } | undefined;
  generateTypesAPI: (input: { dtsManagerOptions: unknown }) => Promise<void>;
};

export type LocalGeneratedZip = {
  zipPath: string;
  zipHash: string;
};

export type GeneratedZip = LocalGeneratedZip & {
  zipUrl: string;
};

export type GenerationInput = {
  appDir: string;
  name: string;
  configFile: string;
  bundler?: "rslib";
  envMode: string;
  env?: Readonly<Record<string, string>>;
  allowLocalEnv?: boolean;
  configDirectory?: ConfigDirectory;
};

export type LocalGenerationInput = GenerationInput & {
  parallel?: boolean;
  workspaceFingerprint: string;
  confirmed?: LocalGeneratedZip & { inputsFingerprint: string };
};

export type GenerationPhaseTimings = {
  prepareMs: number;
  inputsMs: number;
  compileMs: number;
  zipMs: number;
};

export function emptyGenerationPhaseTimings(): GenerationPhaseTimings {
  return { prepareMs: 0, inputsMs: 0, compileMs: 0, zipMs: 0 };
}

export type MeasureGenerationPhase = <T>(
  phase: keyof GenerationPhaseTimings,
  work: () => Promise<T>,
) => Promise<T>;

export type GenerationTimings = GenerationPhaseTimings & {
  queueMs: number;
  processMs: number;
};

export type LocalGenerationResult = LocalGeneratedZip & {
  inputsFingerprint: string | null;
  current: boolean;
  timings?: GenerationTimings;
};

export type GenerationRequest = GenerationInput | LocalGenerationInput;

export type GenerationResult = {
  archive: LocalGenerationResult;
  port: number | null;
};

export type GenerationProgress = {
  timings: GenerationPhaseTimings;
  activePhase?: keyof GenerationPhaseTimings;
};

export type GenerationReply = (
  | { result: GenerationResult }
  | {
      error: string;
      details?: DiagnosticDetails;
      problems?: readonly SourceProblem[];
    }
) & { kind: "mf-dashboard.generation-reply"; timings: GenerationPhaseTimings };

export type GenerationMessage =
  GenerationReply | ({ kind: "mf-dashboard.generation-progress" } & GenerationProgress);
