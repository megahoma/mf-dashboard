import { existsSync } from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import {
  DEFAULT_ENV_MODE,
  DEFAULT_TSCONFIG,
  DEFAULT_TYPES_FOLDER,
} from "../../../shared/config/project.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import {
  MAX_CONFIG_LOCATION_LENGTH,
  MAX_REMOTE_LOCATION_WORK,
  TAG,
  UNKNOWN,
} from "../config/config.ts";
import type {
  ConfigCandidate,
  ConfigContext,
  FederationOwnership,
  LocalApp,
  MissingTemplate,
  Value,
} from "../models/config.ts";
import { ConfigImports } from "./config-imports.ts";
import { CONFIG_INPUT_LIMIT, readConfigDirectory, readConfigInput } from "./config-input.ts";
import {
  joinManifestPath,
  joinViteManifestPath,
  portValue,
  rsbuildDevManifestResolver,
  viteManifestBase,
} from "./dev-manifest.ts";
import { rslibDtsExposes, rslibMfConfig } from "./rslib-config.ts";
import { StaticConfig } from "./static-config.ts";
import { flag, object, remoteNameSeparator, string } from "./static-values.ts";
import { parseProgram } from "./syntax.ts";

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  const parsed = parseProgram(source, filePath);
  return parsed ? readConfigCandidate(new ConfigImports(parsed), env).app : null;
}

export function readStaticConfigFile(
  file: string,
  env: Record<string, string>,
  context: ConfigContext,
  allowLocalEnv = true,
  directory = readConfigDirectory(path.dirname(file)),
): ConfigCandidate | null {
  if (!directory) return null;
  const source = readConfigInput(file, CONFIG_INPUT_LIMIT, { expectedDirectory: directory });
  const parsed = source === null ? null : parseProgram(source, file);
  return parsed
    ? readConfigCandidate(
        new ConfigImports(parsed, undefined, noLog, allowLocalEnv, undefined, directory),
        env,
        noLog,
        context,
      )
    : null;
}

export function readRslibDevelopmentHelpers(
  imports: ConfigImports,
  env: Record<string, string> = {},
): FederationOwnership | undefined {
  const dev = { ...env, NODE_ENV: DEFAULT_ENV_MODE };
  const evaluator = new StaticConfig(imports, dev, noLog, {
    bundler: "rslib",
    trackRslibOwnership: true,
    mode: DEFAULT_ENV_MODE,
    processEnv: dev,
  });
  const config = rslibMfConfig(evaluator.config());
  return config ? evaluator.federationOwnership(evaluator.options(config)) : undefined;
}

export function readConfigCandidate(
  imports: ConfigImports,
  env: Record<string, string>,
  log: LogContext = noLog,
  context?: ConfigContext,
): ConfigCandidate {
  const filePath = imports.entry.file;
  const bundlerHint =
    context?.bundler ?? /^(vite|rsbuild|rslib)\.config\./.exec(path.basename(filePath))?.[1];
  const evaluate = (bundler: string | undefined) =>
    new StaticConfig(imports, env, log, {
      ...context,
      bundler,
      processEnv:
        bundler === "rslib" ? { NODE_ENV: DEFAULT_ENV_MODE, ...env } : context?.processEnv,
    });
  let evaluator = evaluate(bundlerHint);
  let evaluated = evaluator.config();
  if (evaluator.bundler === "rslib" && bundlerHint !== "rslib") {
    // An explicitly selected file may identify the bundler only through its import.
    evaluator = evaluate("rslib");
    evaluated = evaluator.config();
  }
  const { bundler, importedBundler } = evaluator;
  const hasRslibProfile =
    object(evaluated) && (Object.hasOwn(evaluated, "lib") || evaluated.format === "mf");
  const config = bundler === "rslib" ? rslibMfConfig(evaluated) : evaluated;
  const folder =
    bundler === "rslib" && context?.resolveRslibRoot
      ? context.resolveRslibRoot(object(evaluated) ? evaluated.root : undefined)
      : (context?.appDir ?? path.dirname(filePath));
  const options =
    folder === null || (config === null && bundler === "rslib") ? null : evaluator.options(config);
  const federationOwnership =
    bundler === "rslib" && context?.trackRslibOwnership && folder !== null
      ? config !== null
        ? evaluator.federationOwnership(options)
        : readRslibDevelopmentHelpers(imports, env)
      : undefined;
  const server = object(config) && object(config.server) ? config.server : null;
  const devServer = object(config) && object(config.devServer) ? config.devServer : null;
  const usesDefaultRslibPort =
    bundler === "rslib" &&
    options !== null &&
    object(config) &&
    (config.server === undefined || (server !== null && server.port === undefined));
  const port =
    portValue(server?.port) ??
    (bundler === "rslib" ? (usesDefaultRslibPort ? 3000 : null) : portValue(devServer?.port));
  const serverBase = locationString(server?.base) ?? "";
  const rsbuildBase = bundler === "rsbuild" || bundler === "rslib" ? serverBase : undefined;
  const isVite =
    bundler === "vite" ||
    (bundler === undefined && evaluator.plugins.get(options) === "@module-federation/vite");
  const viteBase = isVite
    ? viteManifestBase(context?.viteBase ?? (object(config) ? config.base : undefined))
    : undefined;
  const resolveRsbuildDevManifest =
    rsbuildBase !== undefined &&
    object(config) &&
    object(config.dev) &&
    typeof config.dev.assetPrefix === "string"
      ? rsbuildDevManifestResolver(
          bundler === "rslib"
            ? rslibMfConfig(evaluator.configForDevRoutes())
            : evaluator.configForDevRoutes(),
          port,
        )
      : undefined;
  const outputDir = buildOutputDir(config);
  const name = options && string(options.name);
  if (!options || !name || folder === null)
    return {
      app: null,
      bundler,
      importedBundler,
      hasRslibProfile,
      federationOwnership,
      port,
      outputDir,
      rsbuildBase,
      viteBase,
      resolveRsbuildDevManifest,
    };
  const dts = object(options.dts) ? options.dts : null;
  const dtsEnabled =
    options.dts === true ||
    (bundler === "rslib" &&
      options.dts === undefined &&
      existsSync(path.join(folder, DEFAULT_TSCONFIG)));
  const generateTypes = dts ? flag(dts.generateTypes, true) : dtsEnabled;
  const consumeTypes = dts ? flag(dts.consumeTypes, true) : dtsEnabled;
  const generate = dts && object(dts.generateTypes) ? dts.generateTypes : null;
  const consume = dts && object(dts.consumeTypes) ? dts.consumeTypes : null;
  const generatedFolder =
    generate?.typesFolder === undefined ? DEFAULT_TYPES_FOLDER : string(generate.typesFolder);
  const zipName = generatedFolder ? `${generatedFolder}.zip` : null;
  const dtsOutput = generate?.outputDir;
  const zipOutput = dtsOutput === undefined ? outputDir : string(dtsOutput);
  const exposes = bundler === "rslib" ? rslibDtsExposes(options.exposes) : options.exposes;
  const manifest = object(options.manifest) ? options.manifest : null;
  const fileName = locationString(manifest?.fileName) ?? "mf-manifest.json";
  const manifestDir = locationString(manifest?.filePath) ?? "";
  const manifestFile = path.posix.join(manifestDir, fileName);
  const rsbuildManifestFile = path.posix.join(
    manifestDir,
    fileName.endsWith(".json") ? fileName : `${fileName}.json`,
  );
  const manifestPath =
    rsbuildBase !== undefined
      ? joinManifestPath(rsbuildBase, rsbuildManifestFile)
      : viteBase !== undefined
        ? joinViteManifestPath(viteBase, manifestFile)
        : joinManifestPath(serverBase, fileName);
  const devManifestPath = resolveRsbuildDevManifest?.(rsbuildManifestFile);
  const federationNameOrigin = context?.trackRslibOwnership
    ? evaluator.federationNameOrigin(options)
    : undefined;
  const app: LocalApp = {
    name,
    folder,
    configFile: evaluator.origins.get(options) ?? filePath,
    port,
    manifest: flag(options.manifest, bundler === "rslib"),
    generateTypes,
    consumeTypes,
    typesFolder:
      (consumeTypes && string(consume?.typesFolder)) ||
      (generateTypes && string(generate?.typesFolder)) ||
      DEFAULT_TYPES_FOLDER,
    tsconfig: (generateTypes && string(generate?.tsConfigPath)) || string(dts?.tsConfigPath),
    compilerInstance: generateTypes ? string(generate?.compilerInstance) : null,
    ...(bundler === "rslib" && { bundler, rslibConfigFile: filePath }),
    ...(federationNameOrigin && { federationNameOrigin }),
    manifestPath,
    ...(devManifestPath && devManifestPath !== manifestPath && { devManifestPath }),
    remotes: readRemotes(options.remotes),
    ...(generateTypes && {
      buildConfigFile: filePath,
      generatedZipPath: zipName && zipOutput ? path.resolve(folder, zipOutput, zipName) : null,
      hasExposes:
        exposes === UNKNOWN ||
        (object(exposes) && Object.keys(exposes).length > 0) ||
        (Array.isArray(exposes) && exposes.length > 0),
    }),
  };
  return {
    app,
    federationOptions: exposes === options.exposes ? options : { ...options, exposes },
    federationOwnership,
    bundler,
    importedBundler,
    hasRslibProfile,
    port,
    outputDir,
    rsbuildBase,
    viteBase,
    resolveRsbuildDevManifest,
    manifestFile,
    rsbuildManifestFile,
    bundlerZipName: generateTypes && dtsOutput === undefined && zipName ? zipName : undefined,
  };
}

function buildOutputDir(config: Value): string | null {
  if (!object(config)) return null;
  const { output, build } = config;
  if (output !== undefined && !object(output)) return null;
  if (build !== undefined && !object(build)) return null;
  const distPath = output?.distPath;
  const directory = output?.path ?? (object(distPath) ? distPath.root : distPath) ?? build?.outDir;
  return directory === undefined ? "dist" : string(directory);
}

function readRemotes(value: Value): LocalApp["remotes"] {
  if (!object(value)) return [];
  let remaining = MAX_REMOTE_LOCATION_WORK;
  const reserve = (location: string) => {
    if (location.length > MAX_CONFIG_LOCATION_LENGTH || location.length > remaining) return false;
    remaining -= location.length;
    return true;
  };
  // One static binding can supply the same URL to many aliases in a worker reply.
  return Object.entries(value).map(([alias, entry]) => readRemote(alias, entry, reserve));
}

function readRemote(
  alias: string,
  value: Value,
  reserve: (location: string) => boolean,
): LocalApp["remotes"][number] {
  if (object(value)) return readRemote(alias, value.external ?? value.entry, reserve);
  if (Array.isArray(value)) return readRemote(alias, value[0], reserve);
  if (value && typeof value === "object" && TAG in value && value[TAG] === "missing-template") {
    const name = (value as MissingTemplate).name;
    return { alias, name: name && reserve(name) ? name : alias, url: null };
  }
  if (typeof value !== "string" || !reserve(value)) return { alias, name: alias, url: null };
  const at = remoteNameSeparator(value);
  const name = at > 0 ? value.slice(0, at) : alias;
  const url = (at > 0 ? value.slice(at + 1) : value).trim();
  return { alias, name, url: url && !url.includes("${") ? url : null };
}

function locationString(value: Value): string | null {
  const input = string(value);
  return input !== null && input.length <= MAX_CONFIG_LOCATION_LENGTH ? input : null;
}
