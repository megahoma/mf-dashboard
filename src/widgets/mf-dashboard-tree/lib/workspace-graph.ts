import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { glob } from "tinyglobby";
import {
  CONFIG_FILE,
  isIgnoredDirectory,
  parseLaunchScript,
  type LocalApp,
} from "../../../entities/microfrontend/index.ts";
import { DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import {
  canonicalPathIsInside,
  pathIsInside,
  protectPathWhitespace,
} from "../../../shared/lib/paths.ts";
import { isRecord } from "../../../shared/lib/record.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { AppSetting, DashboardSettings, WorkspaceRoot } from "../models/session-types.ts";

export const GRAPH_FILE = ".mf-dashboard/graph.json";
const VERSION = 2;
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const IGNORE_RULES = ["/graph.json", "/.graph-*.tmp"];
const git = promisify(execFile);

type GraphApp = Omit<
  LocalApp,
  | "configInputs"
  | "rebuildConfigStamp"
  | "ownershipSources"
  | "federationHelpers"
  | "federationNameOrigin"
  | "launchEnvironment"
> & {
  setting: Omit<AppSetting, "path" | "workspaceFolder">;
};

type GraphFile = {
  version: number;
  settings: ReturnType<typeof discoverySettings>;
  legacySelections: string | null;
  apps: GraphApp[];
  inputs: Record<string, string | null>;
  candidates: string[];
  unresolvedOverrides?: Record<string, AppSetting>;
};

export type WorkspaceGraph = {
  apps: LocalApp[];
  settings: Record<string, AppSetting>;
  overrides: Record<string, AppSetting>;
  files: { root: string; graph: GraphFile }[];
  incomplete: boolean;
};

function discoverySettings(settings: DashboardSettings) {
  return {
    envMode: settings.envMode,
    startScript: settings.startScript ?? DEFAULT_START_SCRIPT,
    ignorePaths: [...settings.ignorePaths].sort(),
  };
}

function relative(root: string, file: string): string | undefined {
  return pathIsInside(root, file)
    ? path.relative(root, file).split(path.sep).join("/") || "."
    : undefined;
}

function isRelativeGraphPath(file: unknown): file is string {
  return (
    typeof file === "string" && file !== "" && !/[\\:\0]/.test(file) && !path.posix.isAbsolute(file)
  );
}

function inside(root: string, file: unknown): string | undefined {
  if (!isRelativeGraphPath(file) || file.split("/").includes("..")) return;
  return path.resolve(root, file);
}

async function confined(root: string, file: string): Promise<boolean> {
  // Check the closest existing ancestor as app and ZIP paths may not exist yet.
  const realRoot = await fs.realpath(root);
  let current = file;
  while (pathIsInside(root, current)) {
    try {
      return canonicalPathIsInside(realRoot, await fs.realpath(current));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT" || current === root) return false;
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) return false;
      } catch (entryError) {
        if (!isRecord(entryError) || entryError.code !== "ENOENT") return false;
      }
      current = path.dirname(current);
    }
  }
  return false;
}

async function readText(root: string, file: string, limit: number): Promise<string | null> {
  if (!(await confined(root, file))) return null;
  try {
    const real = await fs.realpath(file);
    if (!canonicalPathIsInside(await fs.realpath(root), real)) return null;
    const candidate = await fs.stat(real);
    if (!candidate.isFile() || candidate.size > limit) return null;
    const handle = await fs.open(real, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) return null;
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer);
      return bytesRead === stat.size ? buffer.subarray(0, bytesRead).toString("utf8") : null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function contentHash(content: string | null): string | null {
  return content === null
    ? null
    : createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

function selectionHash(apps: DashboardSettings["apps"]): string | null {
  if (!apps || !Object.keys(apps).length) return null;
  return contentHash(
    JSON.stringify(Object.entries(apps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

async function candidateFiles(
  root: string,
  settings: DashboardSettings,
  inputs: GraphFile["inputs"],
): Promise<string[]> {
  const paths = await glob(["**/*.config.{js,jsx,cjs,mjs,ts,tsx,cts,mts}", "**/package.json"], {
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.mf-dashboard/**"],
  });
  const candidates: string[] = [];
  for (const file of paths) {
    const absolute = path.join(root, file);
    if (isIgnoredDirectory(root, path.dirname(absolute), settings.ignorePaths)) continue;
    if (CONFIG_FILE.test(path.basename(file))) {
      // An inactive config can start declaring a microfrontend without changing its name.
      const candidate = Object.hasOwn(inputs, file)
        ? file
        : JSON.stringify([file, contentHash(await readText(root, absolute, MAX_INPUT_BYTES))]);
      candidates.push(candidate);
      continue;
    }
    if (path.basename(file) !== "package.json") continue;
    const text = await readText(root, absolute, MAX_INPUT_BYTES);
    let manifest: unknown;
    try {
      manifest = text === null ? undefined : JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue;
    const launch = parseLaunchScript(
      manifest.scripts[settings.startScript ?? DEFAULT_START_SCRIPT],
    );
    if (!launch?.configFile) continue;
    const config = path.resolve(path.dirname(absolute), launch.root ?? "", launch.configFile);
    const name = relative(root, config);
    if (!name || isIgnoredDirectory(root, path.dirname(config), settings.ignorePaths)) continue;
    const hash = contentHash(await readText(root, config, MAX_INPUT_BYTES));
    candidates.push(JSON.stringify([file, name, hash]));
  }
  return candidates.sort();
}

async function assertUntracked(root: string): Promise<void> {
  try {
    const { stdout } = await git("git", ["ls-files", "-z", "--", GRAPH_FILE], {
      cwd: root,
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2000,
      maxBuffer: 64 * 1024,
    });
    if (!stdout.length) return;
  } catch (error) {
    // A folder without Git can also use the dashboard.
    if (
      isRecord(error) &&
      (error.code === "ENOENT" ||
        (error.code === 128 &&
          typeof error.stderr === "string" &&
          error.stderr.includes("not a git repository")))
    )
      return;
    throw error;
  }
  throw new Error(
    `${GRAPH_FILE} is tracked by Git. Remove it from the index before generating a local graph.`,
  );
}

async function ignoreGraphFiles(root: string, folder: string): Promise<void> {
  const file = path.join(folder, ".gitignore");
  const entry = await fs.lstat(file).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entry && !entry.isFile()) throw new Error("Invalid graph .gitignore");
  const contents = entry ? await readText(root, file, MAX_INPUT_BYTES) : "";
  if (contents === null) throw new Error("Could not read the graph .gitignore");
  const rules = contents.trimEnd().split(/\r?\n/);
  if (IGNORE_RULES.every((rule, index) => rule === rules.at(index - IGNORE_RULES.length))) return;
  const newline = contents && !contents.endsWith("\n") ? "\n" : "";
  const handle = await fs.open(
    file,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    await handle.writeFile(`${newline}${IGNORE_RULES.join("\n")}\n`);
  } finally {
    await handle.close();
  }
}

export async function prepareWorkspaceGraphDirectories(
  roots: readonly WorkspaceRoot[],
): Promise<void> {
  for (const { path: root } of roots) {
    const folder = path.join(root, path.dirname(GRAPH_FILE));
    if (!(await confined(root, folder)))
      throw new Error("Graph directory must stay inside the workspace");
    await fs.mkdir(folder, { recursive: true });
    const entry = await fs.lstat(folder);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid graph directory");
    await assertUntracked(root);
    await ignoreGraphFiles(root, folder);
  }
}

function hasOverride(setting: AppSetting): boolean {
  return !!(
    setting.configFile ||
    setting.manifestPath ||
    setting.typesZipPath ||
    setting.scripts?.start
  );
}

function savedOverride(root: WorkspaceRoot, value: unknown): AppSetting | undefined {
  if (!isRecord(value)) return;
  const folder = inside(root.path, value.path);
  if (!folder) return;
  const pathOverride = (file: unknown) => {
    if (typeof file !== "string" || !file || /[\0]/.test(file)) return;
    const absolute = path.resolve(folder, file);
    return pathIsInside(root.path, absolute) ? path.relative(folder, absolute) : undefined;
  };
  const configFile = pathOverride(value.configFile);
  const typesZipPath = pathOverride(
    typeof value.typesZipPath === "string" ? value.typesZipPath.trim() : undefined,
  );
  const manifestPath = typeof value.manifestPath === "string" ? value.manifestPath : undefined;
  const start =
    isRecord(value.scripts) && typeof value.scripts.start === "string"
      ? value.scripts.start
      : undefined;
  const result: AppSetting = {
    path: relative(root.path, folder)!,
    ...(typeof value.workspaceFolder === "string" &&
      value.workspaceFolder && { workspaceFolder: root.name }),
    ...(configFile && { configFile }),
    ...(typesZipPath && { typesZipPath: protectPathWhitespace(typesZipPath) }),
    ...(manifestPath && { manifestPath }),
    ...(start && { scripts: { start } }),
  };
  return hasOverride(result) ? result : undefined;
}

export async function writeWorkspaceGraphs(
  roots: readonly WorkspaceRoot[],
  settings: DashboardSettings,
  selections: Readonly<Record<string, AppSetting>>,
  apps: readonly LocalApp[],
  ownershipSources: ReadonlySet<string>,
  stillCurrent: () => boolean,
): Promise<void> {
  const prepared: {
    folder: string;
    target: string;
    temporary: string;
    contents: string;
    backup?: string;
  }[] = [];
  const resolvedKeys = new Set(apps.map((app) => app.settingsKey ?? app.name));
  const unresolved = new Map<string, Record<string, AppSetting>>();
  for (const [key, selection] of Object.entries(selections)) {
    if (
      resolvedKeys.has(key) ||
      !selection ||
      typeof selection.path !== "string" ||
      !hasOverride(selection)
    )
      continue;
    const zip = typeof selection.typesZipPath === "string" ? selection.typesZipPath.trim() : "";
    const scoped =
      !!selection.workspaceFolder ||
      [selection.path, selection.configFile, zip].some(
        (file) => typeof file === "string" && path.isAbsolute(file),
      );
    // Track portable unresolved paths in every root until Find can resolve the app.
    for (const root of roots) {
      if (selection.workspaceFolder && selection.workspaceFolder !== root.name) continue;
      const override = savedOverride(root, {
        ...selection,
        path: relative(root.path, path.resolve(root.path, selection.path)),
        workspaceFolder: scoped ? root.name : undefined,
      });
      if (!override) continue;
      let byName = unresolved.get(root.path);
      if (!byName)
        unresolved.set(root.path, (byName = Object.create(null) as Record<string, AppSetting>));
      byName[key] = override;
      if (scoped) break;
    }
  }
  const storageRoots = new Map(
    apps.map((app) => {
      const key = app.settingsKey ?? app.name;
      const setting = Object.hasOwn(selections, key) ? selections[key] : undefined;
      const eligible = roots.filter(
        ({ path: root }) =>
          pathIsInside(root, app.folder) && pathIsInside(root, app.launchFolder ?? app.folder),
      );
      const owner =
        eligible.find(({ name }) => name === setting?.workspaceFolder) ??
        [...eligible].sort((a, b) => b.path.length - a.path.length)[0];
      if (!owner) throw new Error("Microfrontend paths must stay inside the workspace");
      return [app, owner.path];
    }),
  );
  for (const root of roots) {
    const identity = root.path;
    const folder = path.join(identity, path.dirname(GRAPH_FILE));
    const inputs: Record<string, string | null> = Object.create(null);
    const track = async (file: string) => {
      const name = relative(identity, file);
      if (name && !Object.hasOwn(inputs, name))
        inputs[name] = contentHash(await readText(identity, file, MAX_INPUT_BYTES));
      return name;
    };
    const stored: GraphApp[] = [];
    for (const app of apps.filter((item) => storageRoots.get(item) === identity)) {
      const key = app.settingsKey ?? app.name;
      const selection = Object.hasOwn(selections, key) ? selections[key] : undefined;
      const configFile = relative(identity, app.configFile);
      const appFolder = relative(identity, app.folder);
      const launchFolder = app.launchFolder && relative(identity, app.launchFolder);
      if (!configFile || !appFolder || (app.launchFolder && !launchFolder))
        throw new Error("Microfrontend paths must stay inside the workspace");
      const dependencies = new Set([
        app.configFile,
        ...(app.buildConfigFile ? [app.buildConfigFile] : []),
        ...(app.configDependencies ?? []),
        ...(app.configInputs ?? [])
          .filter(
            (input) =>
              !("directorySelection" in input) &&
              !("resolutionRoot" in input) &&
              !("packageBoundary" in input) &&
              !("packageDirectory" in input),
          )
          .map(({ file }) => file),
        ...ownershipSources,
      ]);
      const appDependencies: string[] = [];
      for (const file of [...dependencies].sort()) {
        const name = await track(file);
        if (name) appDependencies.push(name);
      }
      const start = selection?.scripts?.start;
      const manifestPath = selection?.manifestPath;
      const explicitConfig =
        selection?.configFile &&
        relative(identity, path.resolve(identity, selection.path, selection.configFile));
      const zipOverride =
        typeof selection?.typesZipPath === "string" ? selection.typesZipPath.trim() : "";
      const zip = zipOverride && relative(identity, path.resolve(app.folder, zipOverride));
      const setting: GraphApp["setting"] = {
        ...(explicitConfig && { configFile: explicitConfig }),
        ...(zip && { typesZipPath: zip }),
        ...(typeof start === "string" && { scripts: { start } }),
        ...(typeof manifestPath === "string" && { manifestPath }),
      };
      const generated =
        app.generatedZipPath && relative(identity, path.resolve(app.folder, app.generatedZipPath));
      const tsconfig = app.tsconfig && relative(identity, path.resolve(app.folder, app.tsconfig));
      stored.push({
        name: app.name,
        folder: appFolder,
        configFile,
        ...(launchFolder && { launchFolder }),
        ...(app.buildConfigFile && { buildConfigFile: relative(identity, app.buildConfigFile) }),
        ...(app.rslibConfigFile && { rslibConfigFile: relative(identity, app.rslibConfigFile) }),
        ...(app.bundler && { bundler: app.bundler }),
        ...(generated && { generatedZipPath: generated }),
        ...(app.devManifestPath !== undefined && { devManifestPath: app.devManifestPath }),
        ...(app.hasExposes !== undefined && { hasExposes: app.hasExposes }),
        port: app.port,
        manifest: app.manifest,
        manifestPath: app.manifestPath,
        generateTypes: app.generateTypes,
        consumeTypes: app.consumeTypes,
        typesFolder: app.typesFolder,
        tsconfig: tsconfig || null,
        compilerInstance: app.compilerInstance,
        settingsKey: key,
        configDependencies: appDependencies,
        setting,
        remotes: app.remotes,
      });
    }
    const unresolvedOverrides = unresolved.get(identity);
    for (const { path: appPath, configFile } of Object.values(unresolvedOverrides ?? {})) {
      const folder = path.resolve(identity, appPath);
      await track(path.join(folder, "package.json"));
      if (configFile) await track(path.resolve(folder, configFile));
    }
    const graph: GraphFile = {
      version: VERSION,
      settings: discoverySettings(settings),
      legacySelections: selectionHash(settings.apps),
      apps: stored.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      inputs: Object.fromEntries(
        Object.keys(inputs)
          .sort()
          .map((key) => [key, inputs[key]]),
      ),
      candidates: await candidateFiles(identity, settings, inputs),
      ...(unresolvedOverrides && { unresolvedOverrides }),
    };
    const contents = JSON.stringify(graph, null, 2) + "\n";
    if (Buffer.byteLength(contents) > MAX_GRAPH_BYTES)
      throw new Error("Microfrontend graph is too large");
    const target = path.join(identity, GRAPH_FILE);
    if (!(await confined(identity, target)))
      throw new Error("Graph path must stay inside the workspace");
    prepared.push({
      folder,
      target,
      temporary: path.join(folder, `.graph-${randomUUID()}.tmp`),
      contents,
    });
  }
  if (!stillCurrent()) throw new Error("Workspace changed during Find microfrontends");
  const published: typeof prepared = [];
  const lockPaths = new Map<string, string>();
  const lostLocks = new Map<string, Error>();
  const releaseLocks: (() => Promise<void>)[] = [];
  try {
    for (const entry of prepared) {
      if (!(await fs.lstat(entry.folder)).isDirectory()) throw new Error("Invalid graph directory");
      lockPaths.set(entry.folder, await fs.realpath(entry.folder));
    }
    // A single order lets windows with overlapping workspace folders publish independently.
    for (const folder of [...new Set(lockPaths.values())].sort()) {
      releaseLocks.push(
        await lock(folder, {
          realpath: false,
          lockfilePath: path.join(folder, ".graph-write.tmp"),
          stale: 60_000,
          update: 5_000,
          retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
          onCompromised: (error) => lostLocks.set(folder, error),
        }),
      );
    }
    if (!stillCurrent()) throw new Error("Workspace changed during Find microfrontends");
    for (const entry of prepared) {
      const previous = await fs.lstat(entry.target).catch((error: unknown) => {
        if (isRecord(error) && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (previous) {
        if (!previous.isFile()) throw new Error("Invalid existing microfrontend graph file");
        const backup = path.join(entry.folder, `.graph-${randomUUID()}.tmp`);
        await fs.copyFile(entry.target, backup, fs.constants.COPYFILE_EXCL);
        entry.backup = backup;
      }
      await fs.writeFile(entry.temporary, entry.contents, { flag: "wx", mode: 0o600 });
    }
    if (!stillCurrent()) throw new Error("Workspace changed during Find microfrontends");
    for (const entry of prepared) {
      const lost = lostLocks.values().next().value;
      if (lost) throw lost;
      await fs.rename(entry.temporary, entry.target);
      published.push(entry);
    }
  } catch (error) {
    const restored = await Promise.allSettled(
      published.map(async (entry) => {
        const { backup, target } = entry;
        const lost = lostLocks.get(lockPaths.get(entry.folder)!);
        if (lost) {
          delete entry.backup;
          throw new Error(
            `Could not restore ${target} after losing the graph lock${backup ? `. Previous graph is in ${backup}` : ""}`,
            { cause: lost },
          );
        }
        if (!backup) return fs.rm(target, { force: true });
        // Leave the backup available if the filesystem rejects the restore.
        delete entry.backup;
        try {
          await fs.rename(backup, target);
        } catch (cause) {
          throw new Error(`Could not restore ${target}. Previous graph is in ${backup}`, { cause });
        }
      }),
    );
    const failures = restored.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `Could not restore the workspace graphs\n${failures.join("\n")}`,
        { cause: error },
      );
    throw error;
  } finally {
    await Promise.allSettled(
      prepared.flatMap(({ temporary, backup }) =>
        (backup ? [temporary, backup] : [temporary]).map((file) => fs.rm(file, { force: true })),
      ),
    );
    await Promise.allSettled(releaseLocks.map((release) => release()));
  }
}

function fileList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((file) => typeof file === "string");
}

async function decodeApp(root: WorkspaceRoot, entry: unknown, version: number) {
  if (!isRecord(entry) || !isRecord(entry.setting)) throw new Error("Invalid graph application");
  const folder = inside(root.path, entry.folder);
  const configFile = inside(root.path, entry.configFile);
  const launchFolder =
    entry.launchFolder === undefined ? undefined : inside(root.path, entry.launchFolder);
  const buildConfigFile =
    entry.buildConfigFile === undefined ? undefined : inside(root.path, entry.buildConfigFile);
  const rslibConfigFile =
    entry.rslibConfigFile === undefined ? undefined : inside(root.path, entry.rslibConfigFile);
  const tsconfig = entry.tsconfig === null ? null : inside(root.path, entry.tsconfig);
  const generatedZipPath =
    entry.generatedZipPath === undefined ? undefined : inside(root.path, entry.generatedZipPath);
  const typesFolder = entry.typesFolder;
  const typesPath =
    folder && isRelativeGraphPath(typesFolder) ? path.resolve(folder, typesFolder) : undefined;
  if (
    !folder ||
    !configFile ||
    typeof entry.name !== "string" ||
    !entry.name ||
    typeof entry.settingsKey !== "string" ||
    !entry.settingsKey ||
    typeof entry.manifest !== "boolean" ||
    typeof entry.generateTypes !== "boolean" ||
    typeof entry.consumeTypes !== "boolean" ||
    typeof entry.manifestPath !== "string" ||
    typeof typesFolder !== "string" ||
    !typesPath ||
    !pathIsInside(root.path, typesPath) ||
    !(entry.compilerInstance === null || typeof entry.compilerInstance === "string") ||
    !(
      entry.port === null ||
      (typeof entry.port === "number" &&
        Number.isInteger(entry.port) &&
        entry.port > 0 &&
        entry.port <= 65535)
    ) ||
    ![undefined, "rslib"].includes(entry.bundler as undefined) ||
    (entry.launchFolder !== undefined && !launchFolder) ||
    (entry.buildConfigFile !== undefined && !buildConfigFile) ||
    (entry.rslibConfigFile !== undefined && !rslibConfigFile) ||
    (entry.generatedZipPath !== undefined && !generatedZipPath) ||
    (entry.tsconfig !== null && !tsconfig) ||
    !fileList(entry.configDependencies) ||
    !Array.isArray(entry.remotes)
  )
    throw new Error("Invalid graph application");
  const selection = entry.setting;
  const explicitConfig =
    selection.configFile === undefined ? undefined : inside(root.path, selection.configFile);
  const customZip =
    selection.typesZipPath === undefined ? undefined : inside(root.path, selection.typesZipPath);
  if (
    (selection.configFile !== undefined && !explicitConfig) ||
    (selection.typesZipPath !== undefined && !customZip)
  )
    throw new Error("Invalid override path in microfrontend graph");
  const checkedPaths = [
    folder,
    configFile,
    launchFolder,
    buildConfigFile,
    rslibConfigFile,
    tsconfig,
    generatedZipPath,
    explicitConfig,
    customZip,
    typesPath,
  ].filter((file): file is string => typeof file === "string");
  if (!(await Promise.all(checkedPaths.map((file) => confined(root.path, file)))).every(Boolean))
    throw new Error("Graph application path must stay inside the workspace");
  const app: LocalApp = {
    name: entry.name,
    settingsKey: entry.settingsKey,
    folder,
    configFile,
    launchFolder,
    buildConfigFile,
    rslibConfigFile,
    generatedZipPath,
    port: entry.port,
    manifest: entry.manifest,
    generateTypes: entry.generateTypes,
    consumeTypes: entry.consumeTypes,
    manifestPath: entry.manifestPath,
    devManifestPath: typeof entry.devManifestPath === "string" ? entry.devManifestPath : undefined,
    typesFolder,
    tsconfig: tsconfig ?? null,
    compilerInstance: entry.compilerInstance,
    bundler: entry.bundler === "rslib" ? "rslib" : undefined,
    hasExposes: typeof entry.hasExposes === "boolean" ? entry.hasExposes : undefined,
    configDependencies: entry.configDependencies.flatMap((file) => inside(root.path, file) ?? []),
    remotes: [],
  };
  for (const remote of entry.remotes) {
    if (!isRecord(remote) || typeof remote.name !== "string" || typeof remote.alias !== "string")
      throw new Error("Invalid graph remote");
    // Legacy graphs still supply selections for the next Find. Their inferred URL references are stale.
    const url = version === 1 ? remote.endpoint : remote.url;
    app.remotes.push({
      name: remote.name,
      alias: remote.alias,
      url: typeof url === "string" ? url : null,
    });
  }
  const settings: AppSetting = {
    path: relative(root.path, launchFolder ?? folder)!,
    workspaceFolder: root.name,
    ...(explicitConfig && { configFile: path.relative(launchFolder ?? folder, explicitConfig) }),
    ...(customZip && {
      typesZipPath: protectPathWhitespace(path.relative(folder, customZip) || "."),
    }),
    ...(typeof selection.manifestPath === "string" && { manifestPath: selection.manifestPath }),
    ...(isRecord(selection.scripts) &&
      typeof selection.scripts.start === "string" && {
        scripts: { start: selection.scripts.start },
      }),
  };
  return { app, settings };
}

export async function readWorkspaceGraphs(
  roots: readonly WorkspaceRoot[],
  log: LogContext,
): Promise<WorkspaceGraph> {
  const result: WorkspaceGraph = {
    apps: [],
    settings: Object.create(null),
    overrides: Object.create(null),
    files: [],
    incomplete: false,
  };
  for (const root of roots) {
    try {
      const contents = await readText(root.path, path.join(root.path, GRAPH_FILE), MAX_GRAPH_BYTES);
      if (contents === null) {
        result.incomplete = true;
        continue;
      }
      const graph: unknown = JSON.parse(contents);
      if (
        !isRecord(graph) ||
        (graph.version !== VERSION && graph.version !== 1) ||
        !isRecord(graph.settings) ||
        typeof graph.settings.envMode !== "string" ||
        typeof graph.settings.startScript !== "string" ||
        !fileList(graph.settings.ignorePaths) ||
        !isRecord(graph.inputs) ||
        !Object.entries(graph.inputs).every(
          ([file, hash]) =>
            inside(root.path, file) &&
            (hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))),
        ) ||
        !fileList(graph.candidates) ||
        !Array.isArray(graph.apps) ||
        (graph.unresolvedOverrides !== undefined && !isRecord(graph.unresolvedOverrides))
      )
        throw new Error("Unsupported microfrontend graph");
      const version = graph.version;
      const decoded = await Promise.allSettled(
        graph.apps.map((app) => decodeApp(root, app, version)),
      );
      const apps: Awaited<ReturnType<typeof decodeApp>>[] = [];
      for (const entry of decoded) {
        if (entry.status === "fulfilled") apps.push(entry.value);
        else {
          result.incomplete = true;
          log.event("warn", "graph.app.read.failed", {
            root: root.path,
            error: String(entry.reason),
          });
        }
      }
      const combined = [...result.apps, ...apps.map(({ app }) => app)];
      if (
        new Set(combined.map(({ name }) => name)).size !== combined.length ||
        new Set(combined.map((app) => app.settingsKey ?? app.name)).size !== combined.length
      )
        throw new Error("Duplicate microfrontend in workspace graph");
      result.files.push({ root: root.path, graph: graph as GraphFile });
      for (const { app, settings } of apps) {
        const key = app.settingsKey ?? app.name;
        result.apps.push(app);
        result.settings[key] = settings;
        if (hasOverride(settings)) result.overrides[key] = settings;
      }
      for (const [key, value] of Object.entries(graph.unresolvedOverrides ?? {})) {
        const override = savedOverride(root, value);
        if (
          override &&
          !Object.hasOwn(result.settings, key) &&
          !Object.hasOwn(result.overrides, key)
        )
          result.overrides[key] = override;
      }
    } catch (error) {
      log.event("warn", "graph.read.failed", { root: root.path, error: String(error) });
      result.incomplete = true;
    }
  }
  return result;
}
