import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TYPES_FOLDER } from "../../../shared/config/project.ts";
import { cliDefaults, REBUILD_HINT } from "../config/generate.ts";
import type {
  DtsApi,
  GenerationInput,
  MfOptions,
  RsbuildConfigExport,
} from "../models/generate.ts";
import { generatedZip, zipRevision } from "./generated-zip.ts";

export async function prepareGeneration(input: GenerationInput) {
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
  const configuredDts = typeof loaded.mf.dts === "object" ? loaded.mf.dts : undefined;
  const configured = configuredDts?.generateTypes;
  const overrides = typeof configured === "object" ? configured : undefined;
  const { abortOnError, compileInChildProcess } = cliDefaults.defaultGenerateOptions;
  const { generateTypes } = normalized;
  // The SDK merges the outer DTS options shallowly and applies its own defaults to generateTypes.
  const generate =
    generateTypes === undefined ||
    generateTypes === true ||
    (typeof generateTypes === "object" && generateTypes !== null)
      ? {
          ...(typeof generateTypes === "object" ? generateTypes : undefined),
          abortOnError: overrides?.abortOnError ?? abortOnError,
          compileInChildProcess: overrides?.compileInChildProcess ?? compileInChildProcess,
        }
      : generateTypes;
  const outputDir = loaded.outputDir;
  const dtsManagerOptions = dts.normalizeGenerateTypesOptions({
    context: input.appDir,
    outputDir,
    dtsOptions: { ...normalized, generateTypes: generate },
    pluginOptions: loaded.mf,
  });
  assertCanGenerate(dtsManagerOptions);
  const zipPath = path.resolve(
    input.appDir,
    (generate && generate.outputDir) || outputDir,
    `${typesFolderOf(loaded.mf)}.zip`,
  );
  return {
    port: loaded.port,
    zipPath,
    mfRequire,
    remote: dtsManagerOptions?.remote,
    compilerCwd: configuredDts?.cwd,
    async generate() {
      const before = zipRevision(zipPath);
      // Same API as `mf dts` in @module-federation/cli@2.9.1, including afterGenerate.
      await dts.generateTypesAPI({ dtsManagerOptions });
      return generatedZip(zipPath, before, input.appDir);
    },
  };
}

export function assertCanGenerate(dtsManagerOptions: unknown): void {
  if (!dtsManagerOptions) {
    throw new Error(
      `Module Federation 2.9.1 cannot generate federated types for this config. ${REBUILD_HINT}`,
    );
  }
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
  const generate = typeof mf.dts === "object" ? mf.dts?.generateTypes : undefined;
  if (
    generate &&
    typeof generate === "object" &&
    typeof generate.typesFolder === "string" &&
    generate.typesFolder !== ""
  ) {
    return generate.typesFolder;
  }
  return DEFAULT_TYPES_FOLDER;
}
