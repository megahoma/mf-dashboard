import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { pathIsInside } from "../../../shared/lib/paths.ts";
import { LocatedError, type SourceProblem } from "../../../shared/models/source-problem.ts";
import { captureCompilerProblems } from "./compiler-problems.mts";
import type { StaticConfigValue } from "../../../entities/microfrontend/index.ts";
import { DEFAULT_ENV_MODE, DEFAULT_TYPES_FOLDER } from "../../../shared/config/project.ts";
import {
  cliDefaults,
  MAX_STATIC_DTS_DEPTH,
  MAX_STATIC_DTS_TEXT_LENGTH,
  MAX_STATIC_DTS_VALUES,
  REBUILD_HINT,
} from "../config/generate.ts";
import type {
  DtsApi,
  GenerationInput,
  MfOptions,
  RsbuildConfigExport,
} from "../models/generate.ts";
import { generatedZip, zipRevision } from "./generated-zip.ts";

export async function prepareGeneration(input: GenerationInput) {
  try {
    return await prepare(input);
  } catch (error) {
    const message = errorMessage(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    let upstream: SourceProblem | undefined;
    for (const [, name, line, column] of stack.matchAll(
      /^\s+at (?:.*? \()?(.+):(\d+):(\d+)\)?$/gm,
    )) {
      let file: string;
      try {
        file = name.startsWith("file:") ? fileURLToPath(name) : name;
        if (!path.isAbsolute(file) || !statSync(file, { throwIfNoEntry: false })?.isFile())
          continue;
      } catch {
        continue;
      }
      if (file !== input.configFile && file.split(path.sep).includes("node_modules")) continue;
      const problem = { file, line: Number(line), column: Number(column), message };
      const local = [input.appDir, path.dirname(input.configFile)].some((folder) =>
        pathIsInside(folder, file),
      );
      if (file === input.configFile || local) {
        throw new LocatedError(message, [upstream ?? problem], { cause: error });
      }
      // An imported workspace helper can be outside the app folder but above its config in the stack.
      upstream ??= problem;
    }
    throw new LocatedError(
      message,
      [
        {
          file: input.configFile,
          line: 1,
          column: 1,
          message,
        },
      ],
      { cause: error },
    );
  }
}

async function prepare(input: GenerationInput) {
  const loaded =
    input.bundler === "rslib" ? await loadStaticProject(input) : await loadProject(input);
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
    generate() {
      return captureCompilerProblems(async () => {
        const before = zipRevision(zipPath);
        // Same API as `mf dts` in @module-federation/cli@2.9.1, including afterGenerate.
        await dts.generateTypesAPI({ dtsManagerOptions });
        return generatedZip(zipPath, before, input.appDir);
      });
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

async function loadStaticProject(input: GenerationInput) {
  const { readRslibEnv, readStaticConfigFile } =
    await import("../../../entities/microfrontend/index.ts");
  const { appDir, configFile, envMode, name, allowLocalEnv = true } = input;
  const env = input.env ?? (allowLocalEnv ? readRslibEnv(appDir, envMode) : {});
  const candidate = readStaticConfigFile(
    configFile,
    env,
    { appDir, bundler: "rslib", mode: envMode },
    allowLocalEnv,
    input.configDirectory,
  );
  if (candidate?.app?.name !== name || !candidate.federationOptions)
    throw new Error(
      `Could not resolve the Rslib MF profile for ${name} in ${configFile}. ${REBUILD_HINT}`,
    );
  const { dts, exposes, remotes } = candidate.federationOptions;
  const staticData = staticDataReader(configFile);
  const resolvedDts = staticData(dts, "Module Federation.dts") as MfOptions["dts"];
  const generate = typeof resolvedDts === "object" ? resolvedDts?.generateTypes : undefined;
  const dtsOutputDir = typeof generate === "object" ? generate?.outputDir : undefined;
  const outputDir =
    candidate.outputDir ?? (typeof dtsOutputDir === "string" && dtsOutputDir ? dtsOutputDir : null);
  if (outputDir === null)
    throw new Error(`Could not resolve output.distPath in ${configFile}. ${REBUILD_HINT}`);
  const mf = {
    name,
    dts: resolvedDts,
    ...(typeof generate === "object" &&
      generate?.extractRemoteTypes && {
        remotes: staticData(remotes, "Module Federation.remotes"),
      }),
    exposes: staticData(exposes, "Module Federation.exposes"),
  } as MfOptions;
  Object.assign(process.env, { NODE_ENV: DEFAULT_ENV_MODE, ...env });
  return { mf, port: candidate.port, outputDir };
}

type StaticData =
  string | number | boolean | null | undefined | StaticData[] | { [key: string]: StaticData };

function staticDataReader(file: string) {
  let remainingValues = MAX_STATIC_DTS_VALUES;
  let remainingText = MAX_STATIC_DTS_TEXT_LENGTH;
  const limitError = () =>
    new Error(
      `Static Module Federation options exceed the DTS conversion limit in ${file}. ${REBUILD_HINT}`,
    );

  // The SDK can serialize shared values once per reference, so charge every visit.
  return function staticData(value: StaticConfigValue, field: string, depth = 0): StaticData {
    if (--remainingValues < 0 || depth > MAX_STATIC_DTS_DEPTH) throw limitError();
    if (typeof value === "string") {
      if ((remainingText -= value.length) < 0) throw limitError();
      return value;
    }
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) {
      if (value.length > remainingValues) throw limitError();
      return value.map((item, index) => staticData(item, `${field}[${index}]`, depth + 1));
    }
    if (typeof value === "object" && Object.getOwnPropertySymbols(value).length === 0) {
      const record = value as Record<string, StaticConfigValue>;
      const fields: [string, StaticData][] = [];
      for (const key in record) {
        if (!Object.hasOwn(record, key)) continue;
        if ((remainingText -= key.length) < 0) throw limitError();
        fields.push([key, staticData(record[key], `${field}.${key}`, depth + 1)]);
      }
      return Object.fromEntries(fields);
    }
    throw new Error(`Could not resolve ${field} statically in ${file}. ${REBUILD_HINT}`);
  };
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
      sourceMaps: true,
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
