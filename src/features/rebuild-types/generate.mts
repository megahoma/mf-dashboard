import { localManifestUrl } from "../../shared/urls.ts";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSerialQueue } from "../../shared/queue.ts";
import { runEvidenceTask } from "../../entities/federated-types/evidence-worker-client.mts";
import { DiagnosticError, type DiagnosticDetails } from "../../shared/diagnostic-error.ts";
import {
  compilerInputsFingerprint,
  listCompilerInputs,
  type CompilerInputs,
  type CompilerRemoteOptions,
} from "./compiler-inputs.ts";
import { hashManifestZip } from "./zip-url.ts";

const REBUILD_HINT = "Set mf-dashboard.commands.rebuildTypes.";

const cliDefaults = {
  defaultGenerateOptions: {
    generateAPITypes: true,
    compileInChildProcess: false,
    abortOnError: true,
    extractThirdParty: false,
    extractRemoteTypes: false,
  },
  defaultConsumeOptions: {
    abortOnError: true,
    consumeAPITypes: true,
  },
};

interface GeneratedDts {
  typesFolder?: string;
  outputDir?: string;
  tsConfigPath?: string;
  compilerInstance?: string;
  compileInChildProcess?: boolean;
  afterGenerate?: (info: unknown) => void;
}

interface MfOptions {
  name?: string;
  exposes?: Record<string, string>;
  remotes?: Record<string, string>;
  dts?:
    | false
    | {
        cwd?: string;
        tsConfigPath?: string;
        generateTypes?: false | GeneratedDts;
        consumeTypes?: false | { typesFolder?: string };
      };
}

interface RsbuildConfig {
  plugins?: unknown[];
  server?: { port?: number };
  devServer?: { port?: number };
  output?: { distPath?: { root?: string } };
}

type RsbuildConfigExport =
  | RsbuildConfig
  | ((params: {
      command: "build";
      env: string;
      envMode: string;
    }) => RsbuildConfig | Promise<RsbuildConfig>);

interface DtsApi {
  isTSProject: (dts: unknown, context: string) => boolean;
  normalizeDtsOptions: (
    options: MfOptions,
    context: string,
    defaults: typeof cliDefaults,
  ) => MfOptions["dts"] | false;
  normalizeGenerateTypesOptions: (input: {
    context: string;
    outputDir: string;
    dtsOptions: MfOptions["dts"];
    pluginOptions: MfOptions;
  }) => { remote?: CompilerRemoteOptions } | undefined;
  generateTypesAPI: (input: { dtsManagerOptions: unknown }) => Promise<void>;
}

export interface LocalGeneratedZip {
  zipPath: string;
  zipHash: string;
}

export interface GeneratedZip extends LocalGeneratedZip {
  zipUrl: string;
}

interface GenerationInput {
  appDir: string;
  name: string;
  configFile: string;
  envMode: string;
}

export interface LocalGenerationInput extends GenerationInput {
  env: Readonly<Record<string, string>>;
  workspaceFingerprint: string;
  confirmed?: LocalGeneratedZip & { inputsFingerprint: string };
}

interface LocalGenerationResult extends LocalGeneratedZip {
  inputsFingerprint: string | null;
  current: boolean;
}

export type GenerationReply =
  { result: LocalGenerationResult } | { error: string; details?: DiagnosticDetails };

const oneGeneration = createSerialQueue();

export function generateLocalFederatedTypes(
  input: LocalGenerationInput,
): Promise<LocalGenerationResult> {
  return oneGeneration(
    () =>
      new Promise((resolve, reject) => {
        const bundled = typeof __dirname === "string";
        const entry = bundled
          ? path.join(__dirname, "generate-process.js")
          : fileURLToPath(new URL("./generate-process.ts", import.meta.url));
        // The SDK and project config use process.cwd() and process.env during generation.
        const child = fork(entry, [], {
          cwd: input.appDir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          execArgv: bundled ? [] : undefined,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        let reply: GenerationReply | undefined;
        child.once("message", (message) => {
          reply = message as GenerationReply;
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (reply && "error" in reply) {
            reject(
              reply.details
                ? new DiagnosticError(reply.error, reply.details)
                : new Error(reply.error),
            );
          } else if (code === 0 && reply) resolve(reply.result);
          else reject(new Error(`Type generator exited (${signal ?? code})`));
        });
        child.send(input, (error) => {
          if (error) {
            child.kill();
            reject(error);
          }
        });
      }),
  );
}

export function generateFederatedTypes(
  input: GenerationInput & { port: number | null; manifestPath: string },
): Promise<GeneratedZip> {
  return oneGeneration(async () => {
    const { zipPath, zipHash, name, port: configuredPort } = await generateTypesOnDisk(input);
    const port = input.port ?? configuredPort;
    if (port == null)
      throw new Error(`generated zip is not published by a manifest. ${REBUILD_HINT}`);
    const zipUrl = await assertPublished({
      appDir: input.appDir,
      hostName: name,
      remoteName: name,
      alias: name,
      port,
      manifestPath: input.manifestPath,
      zipHash,
    });
    return { zipPath, zipHash, zipUrl };
  });
}

async function prepareGeneration(input: GenerationInput) {
  const loaded = await loadProject(input);
  const { dts, mfRequire } = loadDts(input.appDir);
  if (!dts.isTSProject(loaded.mf.dts, input.appDir)) {
    throw new Error(
      `Module Federation 2.9.1 did not accept this TypeScript project. ${REBUILD_HINT}`,
    );
  }
  const normalized = dts.normalizeDtsOptions(loaded.mf, input.appDir, cliDefaults);
  if (!normalized) {
    throw new Error(
      `Module Federation 2.9.1 cannot generate federated types for this config. ${REBUILD_HINT}`,
    );
  }
  const outputDir = loaded.outputDir;
  const dtsManagerOptions = dts.normalizeGenerateTypesOptions({
    context: input.appDir,
    outputDir,
    dtsOptions: normalized,
    pluginOptions: loaded.mf,
  });
  assertCanGenerate(dtsManagerOptions);
  const generate = normalized.generateTypes;
  const zipPath = path.resolve(
    input.appDir,
    (generate && generate.outputDir) || outputDir,
    `${typesFolderOf(loaded.mf)}.zip`,
  );
  return {
    name: input.name,
    port: loaded.port,
    zipPath,
    mfRequire,
    remote: dtsManagerOptions?.remote,
    compilerCwd: loaded.mf.dts ? loaded.mf.dts.cwd : undefined,
    async generate() {
      const before = zipRevision(zipPath);
      // Same API as `mf dts` in @module-federation/cli@2.9.1, including afterGenerate.
      await dts.generateTypesAPI({ dtsManagerOptions });
      return generatedZip(zipPath, before, input.appDir);
    },
  };
}

async function generateTypesOnDisk(input: GenerationInput) {
  const { generate, name, port } = await prepareGeneration(input);
  return { ...(await generate()), name, port };
}

export async function generateLocalTypesOnDisk(
  input: LocalGenerationInput,
): Promise<LocalGenerationResult> {
  const { mfRequire, remote, compilerCwd, zipPath, generate } = await prepareGeneration(input);
  const inputs = await listCompilerInputs(mfRequire, remote, input.appDir, compilerCwd);
  return rebuildLocalArchive(input, zipPath, inputs, generate);
}

export async function rebuildLocalArchive(
  input: LocalGenerationInput,
  zipPath: string,
  inputs: CompilerInputs | null,
  generate: () => Promise<LocalGeneratedZip>,
): Promise<LocalGenerationResult> {
  const fingerprint = inputs
    ? await compilerInputsFingerprint(input.workspaceFingerprint, inputs)
    : null;
  const { confirmed } = input;
  if (
    fingerprint &&
    confirmed?.inputsFingerprint === fingerprint &&
    confirmed.zipPath === zipPath
  ) {
    const zip = await readTypesZip(zipPath);
    if (zip && zip.zipHash === confirmed.zipHash)
      return { ...zip, inputsFingerprint: fingerprint, current: true };
  }
  const zip = await generate();
  if (
    inputs &&
    (await compilerInputsFingerprint(input.workspaceFingerprint, inputs)) !== fingerprint
  )
    throw new Error("Compiler inputs changed during type generation");
  return { ...zip, inputsFingerprint: fingerprint, current: false };
}

export function assertCanGenerate(dtsManagerOptions: unknown): void {
  if (!dtsManagerOptions) {
    throw new Error(
      `Module Federation 2.9.1 cannot generate federated types for this config. ${REBUILD_HINT}`,
    );
  }
}

export async function assertPublished(input: {
  appDir: string;
  hostName: string;
  remoteName: string;
  alias: string;
  port: number;
  manifestPath: string;
  zipHash: string;
}): Promise<string> {
  const published = await hashManifestZip({
    appDir: input.appDir,
    hostName: input.hostName,
    remoteName: input.remoteName,
    alias: input.alias,
    manifestUrl: localManifestUrl(input.port, input.manifestPath),
  });
  if (published.zipHash !== input.zipHash)
    throw new Error("published zip does not match the generated archive");
  return published.zipUrl;
}

async function loadProject({ appDir, configFile, name, envMode }: GenerationInput) {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  let enhancedEntry: string;
  let cliEntry: string;
  try {
    enhancedEntry = appRequire.resolve("@module-federation/enhanced");
    cliEntry = createRequire(enhancedEntry).resolve("@module-federation/cli");
  } catch (error) {
    throw new Error(
      `Module Federation is not installed in ${appDir} (${error instanceof Error ? error.message : error}). ${REBUILD_HINT}`,
      { cause: error },
    );
  }
  const { createJiti } = createRequire(cliEntry)("jiti") as {
    createJiti: (id: string, options: Record<string, unknown>) => (id: string) => unknown;
  };
  const capturePath = writeCapturePlugin();
  const state = globalThis as { __mfCapturedPlugins?: Map<unknown, MfOptions> };
  const previous = state.__mfCapturedPlugins;
  const captured = new Map<unknown, MfOptions>();
  state.__mfCapturedPlugins = captured;
  try {
    const jiti = createJiti(configFile, {
      interopDefault: true,
      fsCache: false,
      moduleCache: false,
      alias: { "@module-federation/rsbuild-plugin": capturePath },
    });
    const loaded = jiti(configFile) as
      (RsbuildConfigExport & { default?: RsbuildConfigExport }) | null;
    const exported = loaded?.default ?? loaded;
    const config =
      typeof exported === "function"
        ? await exported({ command: "build", env: process.env.NODE_ENV ?? "production", envMode })
        : exported;
    const plugins = config?.plugins;
    let mf = captured.get(config);
    if (Array.isArray(plugins)) {
      mf = plugins.map((plugin) => captured.get(plugin)).find((options) => options?.name === name);
    } else if (!mf && !Object.hasOwn(config ?? {}, "plugins") && captured.size === 1) {
      // Discovery also accepts a single top-level plugin call without a plugins list.
      mf = captured.values().next().value;
    }
    if (mf?.name !== name)
      throw new Error(
        `could not read Module Federation options for ${name} from ${configFile}. ${REBUILD_HINT}`,
      );
    const port =
      typeof config?.server?.port === "number"
        ? config.server.port
        : typeof config?.devServer?.port === "number"
          ? config.devServer.port
          : null;
    const outputDir = config?.output?.distPath?.root || "dist";
    return { mf, port, outputDir };
  } finally {
    state.__mfCapturedPlugins = previous;
    rmSync(path.dirname(capturePath), { recursive: true, force: true });
  }
}

function writeCapturePlugin(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mf-capture-"));
  const capturePath = path.join(dir, "capture-mf-plugin.cjs");
  writeFileSync(
    capturePath,
    `
exports.pluginModuleFederation = function pluginModuleFederation(options) {
  const plugin = { name: "capture-mf", setup() {} };
  globalThis.__mfCapturedPlugins.set(plugin, options);
  return plugin;
};
exports.ModuleFederationPlugin = exports.pluginModuleFederation;
exports.createModuleFederationConfig = (options) => options;
`,
  );
  return capturePath;
}

function loadDts(appDir: string) {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  const enhancedEntry = appRequire.resolve("@module-federation/enhanced");
  const mfRequire = createRequire(enhancedEntry);
  const dts = mfRequire("@module-federation/dts-plugin") as Partial<DtsApi>;
  if (
    typeof dts.generateTypesAPI !== "function" ||
    typeof dts.normalizeDtsOptions !== "function" ||
    typeof dts.normalizeGenerateTypesOptions !== "function" ||
    typeof dts.isTSProject !== "function"
  ) {
    throw new Error(`Module Federation 2.9.1 dts API cannot generate types. ${REBUILD_HINT}`);
  }
  return { dts: dts as DtsApi, mfRequire };
}

function typesFolderOf(mf: MfOptions): string {
  const dts = mf.dts;
  if (!dts) return "@mf-types";
  const generate = dts.generateTypes;
  if (
    generate &&
    typeof generate === "object" &&
    typeof generate.typesFolder === "string" &&
    generate.typesFolder !== ""
  ) {
    return generate.typesFolder;
  }
  return "@mf-types";
}

export function zipRevision(zipPath: string): string | null {
  const stat = statSync(zipPath, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`types ZIP path is not a file: ${zipPath}`);
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export async function readTypesZip(
  zipPath: string,
  verifyIn?: string,
): Promise<LocalGeneratedZip | null> {
  if (zipRevision(zipPath) == null) return null;
  const bytes = await readFile(zipPath);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  if (verifyIn) await runEvidenceTask({ kind: "archive", bytes, appDir: verifyIn });
  return { zipPath, zipHash: createHash("sha256").update(bytes).digest("hex") };
}

export async function generatedZip(
  zipPath: string,
  before: string | null,
  appDir: string,
): Promise<LocalGeneratedZip> {
  if (before !== null && before === zipRevision(zipPath))
    throw new Error(`generation did not write the types ZIP: ${zipPath}`);
  const zip = await readTypesZip(zipPath, appDir);
  if (!zip) throw new Error(`generated types ZIP is missing or invalid: ${zipPath}`);
  return zip;
}
