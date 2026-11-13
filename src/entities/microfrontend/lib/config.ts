import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_TYPES_FOLDER } from "../../../shared/config/project.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { TAG, UNKNOWN } from "../config/config.ts";
import type {
  ConfigCandidate,
  ConfigContext,
  LocalApp,
  MissingTemplate,
  Value,
} from "../models/config.ts";
import { ConfigImports } from "./config-imports.ts";
import { joinManifestPath, portValue, rsbuildDevManifestResolver } from "./dev-manifest.ts";
import { StaticConfig } from "./static-config.ts";
import { flag, object, remoteNameSeparator, string } from "./static-values.ts";
import { parseProgram } from "./syntax.ts";

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  const parsed = parseProgram(source, filePath);
  return parsed ? readConfigCandidate(new ConfigImports(parsed), source, env).app : null;
}

export function readConfigCandidate(
  imports: ConfigImports,
  source: string,
  env: Record<string, string>,
  log: LogContext = noLog,
  context?: ConfigContext,
): ConfigCandidate {
  const filePath = imports.entry.file;
  const evaluator = new StaticConfig(imports, env, log, {
    ...context,
    bundler: context?.bundler ?? /^(vite|rsbuild)\.config\./.exec(path.basename(filePath))?.[1],
  });
  const options = evaluator.options();
  const config = evaluator.config();
  const { bundler, importedBundler } = evaluator;
  const server = object(config) && object(config.server) ? config.server : null;
  const devServer = object(config) && object(config.devServer) ? config.devServer : null;
  const port = portValue(server?.port) ?? portValue(devServer?.port);
  const serverBase = string(server?.base) ?? "";
  const rsbuildBase = bundler === "rsbuild" ? serverBase : undefined;
  const resolveRsbuildDevManifest =
    rsbuildBase !== undefined &&
    object(config) &&
    object(config.dev) &&
    typeof config.dev.assetPrefix === "string"
      ? rsbuildDevManifestResolver(evaluator.configForDevRoutes(), port)
      : undefined;
  const outputDir = buildOutputDir(config);
  const name = options && string(options.name);
  if (!options || !name)
    return {
      app: null,
      bundler,
      importedBundler,
      port,
      outputDir,
      rsbuildBase,
      resolveRsbuildDevManifest,
    };
  const dts = object(options.dts) ? options.dts : null;
  const generateTypes = dts ? flag(dts.generateTypes, true) : options.dts === true;
  const consumeTypes = dts ? flag(dts.consumeTypes, true) : options.dts === true;
  const generate = dts && object(dts.generateTypes) ? dts.generateTypes : null;
  const consume = dts && object(dts.consumeTypes) ? dts.consumeTypes : null;
  const generatedFolder =
    generate?.typesFolder === undefined ? DEFAULT_TYPES_FOLDER : string(generate.typesFolder);
  const zipName = generatedFolder ? `${generatedFolder}.zip` : null;
  const dtsOutput = generate?.outputDir;
  const zipOutput = dtsOutput === undefined ? outputDir : string(dtsOutput);
  const exposes = options.exposes;
  const manifest = object(options.manifest) ? options.manifest : null;
  const fileName = string(manifest?.fileName) ?? "mf-manifest.json";
  const rsbuildManifestFile = path.posix.join(
    string(manifest?.filePath) ?? "",
    fileName.endsWith(".json") ? fileName : `${fileName}.json`,
  );
  const assetPrefix = source.includes("import.meta.env.ASSET_PREFIX")
    ? env.ASSET_PREFIX?.trim()
    : undefined;
  const manifestPath =
    rsbuildBase === undefined
      ? joinManifestPath(assetPrefix || serverBase, fileName)
      : joinManifestPath(rsbuildBase, rsbuildManifestFile);
  const devManifestPath = resolveRsbuildDevManifest?.(rsbuildManifestFile);
  const folder = context?.appDir ?? path.dirname(filePath);
  const app: LocalApp = {
    name,
    folder,
    configFile: evaluator.origins.get(options) ?? filePath,
    port,
    manifest: flag(options.manifest, false),
    generateTypes,
    consumeTypes,
    typesFolder:
      (consumeTypes && string(consume?.typesFolder)) ||
      (generateTypes && string(generate?.typesFolder)) ||
      DEFAULT_TYPES_FOLDER,
    tsconfig: (generateTypes && string(generate?.tsConfigPath)) || string(dts?.tsConfigPath),
    compilerInstance: generateTypes ? string(generate?.compilerInstance) : null,
    manifestPath,
    ...(devManifestPath && devManifestPath !== manifestPath && { devManifestPath }),
    remotes: object(options.remotes)
      ? Object.entries(options.remotes).map(([alias, value]) => readRemote(alias, value))
      : [],
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
    bundler,
    importedBundler,
    port,
    outputDir,
    rsbuildBase,
    resolveRsbuildDevManifest,
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

function readRemote(alias: string, value: Value): LocalApp["remotes"][number] {
  if (object(value)) return readRemote(alias, value.external ?? value.entry);
  if (Array.isArray(value)) return readRemote(alias, value[0]);
  if (value && typeof value === "object" && TAG in value && value[TAG] === "missing-template")
    return { alias, name: (value as MissingTemplate).name || alias, url: null };
  if (typeof value !== "string") return { alias, name: alias, url: null };
  const at = remoteNameSeparator(value);
  const name = at > 0 ? value.slice(0, at) : alias;
  const url = (at > 0 ? value.slice(at + 1) : value).trim();
  return { alias, name, url: url && !url.includes("${") ? url : null };
}
