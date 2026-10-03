import { localManifestUrl } from "../../shared/urls.ts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSerialQueue } from "../../shared/queue.ts";
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
        tsConfigPath?: string;
        generateTypes?: false | GeneratedDts;
        consumeTypes?: false | { typesFolder?: string };
      };
}

interface RsbuildConfig {
  server?: { port?: number };
  devServer?: { port?: number };
  output?: { distPath?: { root?: string } };
}

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
  }) => unknown;
  generateTypesAPI: (input: { dtsManagerOptions: unknown }) => Promise<void>;
}

export interface GeneratedZip {
  zipPath: string;
  zipHash: string;
  zipUrl: string;
}

const oneGeneration = createSerialQueue();

// Same call as `mf dts` in @module-federation/cli@2.9.1. generateTypesAPI runs afterGenerate.
// One capture uses globalThis, so two generations must not load configs together.
export function generateFederatedTypes(input: {
  appDir: string;
  configFile: string;
  port: number | null;
  manifestPath: string;
}): Promise<GeneratedZip> {
  return oneGeneration(() => generateFederatedTypesNow(input));
}

async function generateFederatedTypesNow(input: {
  appDir: string;
  configFile: string;
  port: number | null;
  manifestPath: string;
}): Promise<GeneratedZip> {
  const loaded = loadProject(input.appDir, input.configFile);
  const dts = loadDts(input.appDir);
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
  await dts.generateTypesAPI({ dtsManagerOptions });
  const zipPath = path.join(input.appDir, outputDir, `${typesFolderOf(loaded.mf)}.zip`);
  const zipHash = hashFile(zipPath);
  const port = input.port ?? loaded.port;
  if (port == null)
    throw new Error(`generated zip is not published by a manifest. ${REBUILD_HINT}`);
  const name = loaded.mf.name ?? "host";
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

function loadProject(
  appDir: string,
  configFile: string,
): { mf: MfOptions; port: number | null; outputDir: string } {
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
  const previous = (globalThis as { __mfCaptured?: MfOptions }).__mfCaptured;
  (globalThis as { __mfCaptured?: MfOptions }).__mfCaptured = undefined;
  try {
    const jiti = createJiti(configFile, {
      interopDefault: true,
      fsCache: false,
      moduleCache: false,
      alias: { "@module-federation/rsbuild-plugin": capturePath },
    });
    const loaded = jiti(configFile) as { default?: RsbuildConfig } & RsbuildConfig;
    const config = loaded.default ?? loaded;
    const mf = (globalThis as { __mfCaptured?: MfOptions }).__mfCaptured;
    if (!mf)
      throw new Error(
        `could not read Module Federation options from ${configFile}. ${REBUILD_HINT}`,
      );
    const port =
      typeof config.server?.port === "number"
        ? config.server.port
        : typeof config.devServer?.port === "number"
          ? config.devServer.port
          : null;
    const outputDir = config.output?.distPath?.root || "dist";
    return { mf, port, outputDir };
  } finally {
    (globalThis as { __mfCaptured?: MfOptions }).__mfCaptured = previous;
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
  globalThis.__mfCaptured = options;
  return { name: "capture-mf", setup() {} };
};
exports.ModuleFederationPlugin = exports.pluginModuleFederation;
`,
  );
  return capturePath;
}

function loadDts(appDir: string): DtsApi {
  const appRequire = createRequire(path.join(appDir, "package.json"));
  const enhancedEntry = appRequire.resolve("@module-federation/enhanced");
  const dts = createRequire(enhancedEntry)("@module-federation/dts-plugin") as Partial<DtsApi>;
  if (
    typeof dts.generateTypesAPI !== "function" ||
    typeof dts.normalizeDtsOptions !== "function" ||
    typeof dts.normalizeGenerateTypesOptions !== "function" ||
    typeof dts.isTSProject !== "function"
  ) {
    throw new Error(`Module Federation 2.9.1 dts API cannot generate types. ${REBUILD_HINT}`);
  }
  return dts as DtsApi;
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

function hashFile(zipPath: string): string {
  if (!existsSync(zipPath)) throw new Error(`generated zip is missing at ${zipPath}`);
  const bytes = readFileSync(zipPath);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new Error("generated file is not a zip");
  return sha256(bytes);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
