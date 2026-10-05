import { noLog, type LogContext } from "../../shared/logging.ts";
import fs from "node:fs";
import glob from "fast-glob";
import { createFilesMatcher, parseTsconfig, type TsConfigJsonResolved } from "get-tsconfig";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import micromatch from "micromatch";
import path from "node:path";
import { filesFingerprint } from "../../shared/fingerprint.ts";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const ROOT_OUTPUT_DIRS = ["dist", "build", "out", "coverage", ".mf", ".turbo"];

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}

export interface SourceSnapshot {
  savedAt: number | null;
  files: SourceFile[];
}

export interface SourceIdentity {
  savedAt: number | null;
  fingerprint: string;
  names: string[];
}

const sourceCache = new Map<string, { stamp: string; identity: SourceIdentity }>();

interface SourceEntry {
  name: string;
  fullPath: string;
  savedAt: number;
  size: number;
}

// Same-size edits that preserve mtime reuse the fingerprint, matching the freshness clock.
export function sourceIdentity(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  log: LogContext = noLog,
): SourceIdentity {
  const entries = sourceEntries(folder, tsconfig, typesFolder);
  const stamp = entries
    .map((entry) => `${entry.name}\0${entry.size}\0${entry.savedAt}`)
    .sort()
    .join("\n");
  const key = `${path.resolve(folder)}\0${tsconfig ?? ""}\0${typesFolder}`;
  const hit = sourceCache.get(key);
  if (hit?.stamp === stamp) {
    log.event("debug", "fingerprint.sources.hit", {
      folder,
      scans: 1,
      reads: 0,
      files: entries.length,
    });
    return { ...hit.identity, names: [...hit.identity.names] };
  }
  log.event("debug", "fingerprint.sources.miss", {
    folder,
    scans: 1,
    reads: entries.length,
    files: entries.length,
  });
  const identity: SourceIdentity = {
    savedAt: entries.reduce<number | null>(
      (latest, entry) => (latest == null || entry.savedAt > latest ? entry.savedAt : latest),
      null,
    ),
    fingerprint: filesFingerprint(
      entries.map((entry) => ({
        name: entry.name,
        bytes: new Uint8Array(fs.readFileSync(entry.fullPath)),
      })),
    ),
    names: entries.map((entry) => entry.name).sort(),
  };
  sourceCache.set(key, { stamp, identity });
  return { ...identity, names: [...identity.names] };
}

// Own .ts/.tsx from the producer's tsconfig. Downloaded types and emit directories are not sources.
export function sourceSnapshot(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
): SourceSnapshot {
  const entries = sourceEntries(folder, tsconfig, typesFolder);
  return {
    savedAt: entries.reduce<number | null>(
      (latest, entry) => (latest == null || entry.savedAt > latest ? entry.savedAt : latest),
      null,
    ),
    files: entries.map((entry) => ({
      name: entry.name,
      bytes: new Uint8Array(fs.readFileSync(entry.fullPath)),
    })),
  };
}

export function sourceContains(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  file: string,
): boolean {
  const full = path.resolve(file);
  return sourceEntries(folder, tsconfig, typesFolder).some((entry) => entry.fullPath === full);
}

function readSourceConfig(file: string): TsConfigJsonResolved {
  // Fresh library cache observes edits to every inherited config and package.json.
  const cache = new Map<string, string>();
  try {
    const config = parseTsconfig(file, cache);
    // get-tsconfig recovers malformed JSONC. Validate all raw inputs before using its result.
    // Its readFileSync cache keys are covered by inherited-config tests; keep the version pinned.
    for (const [key, text] of cache) {
      if (!key.startsWith("readFileSync:") || typeof text !== "string") continue;
      const errors: ParseError[] = [];
      const value: unknown = parseJsonc(text, errors, {
        allowTrailingComma: true,
        allowEmptyContent: true,
      });
      if (
        errors.length ||
        (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      )
        throw new Error("Malformed JSONC");
      if (value === undefined) continue;
      if (/[/\\]package\.json:utf8$/.test(key) && key !== `readFileSync:${file}:utf8`) continue;
      const raw = value as Record<string, unknown>;
      const inherited = raw.extends;
      if (
        inherited !== undefined &&
        typeof inherited !== "string" &&
        (!Array.isArray(inherited) || inherited.some((value) => typeof value !== "string"))
      )
        throw new Error("Invalid extends");
      for (const field of ["files", "include", "exclude"] as const) {
        const values = raw[field];
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
          throw new Error(`Invalid ${field}`);
        if (field === "files") continue;
        for (const pattern of values as string[]) {
          const parts = pattern.replaceAll("\\", "/").split("/");
          const recursive = parts.indexOf("**");
          if (
            (field === "include" && /(?:^|\/)\*\*\/?$/.test(parts.join("/"))) ||
            (recursive >= 0 && parts.slice(recursive + 1).includes(".."))
          )
            throw new Error(`Invalid ${field} pattern`);
        }
      }
      const options = raw.compilerOptions;
      if (options !== undefined) {
        if (!options || typeof options !== "object" || Array.isArray(options))
          throw new Error("Invalid compilerOptions");
        for (const field of ["outDir", "declarationDir"] as const) {
          const option = (options as Record<string, unknown>)[field];
          if (option !== undefined && typeof option !== "string")
            throw new Error(`Invalid ${field}`);
        }
      }
    }
    return config;
  } catch (error) {
    throw new Error(`Invalid tsconfig: ${file}`, { cause: error });
  }
}

function sourceEntries(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
): SourceEntry[] {
  const folderPath = path.resolve(folder);
  try {
    if (fs.lstatSync(folderPath).isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const root = fs.realpathSync(folderPath);
  let configFile = path.resolve(root, tsconfig?.trim() || "tsconfig.json");
  const inside = (file: string): boolean => {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const outputs = [
    ...ROOT_OUTPUT_DIRS.map((name) => path.join(root, name)),
    ...(typesFolder ? [path.resolve(root, typesFolder)] : []),
  ].filter(inside);
  const ownPath = (file: string): boolean => {
    const relative = path.relative(root, file);
    if (!inside(file)) return false;
    if (outputs.some((output) => file === output || file.startsWith(`${output}${path.sep}`)))
      return false;
    let current = root;
    for (const segment of relative.split(path.sep)) {
      if (SKIP_DIRS.has(segment)) return false;
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return true;
  };
  const ownFile = (file: string): boolean =>
    ownPath(file) && /\.tsx?$/.test(file) && !file.endsWith(".d.ts");
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let hasConfig = true;
  try {
    fs.statSync(configFile);
    configFile = fs.realpathSync(configFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") hasConfig = false;
    else throw error;
  }
  const config = hasConfig ? readSourceConfig(configFile) : {};
  const configDirectory = hasConfig ? path.dirname(configFile) : root;
  if (hasConfig) {
    const outDir = config.compilerOptions?.outDir;
    if (outDir) {
      const output = path.resolve(path.dirname(configFile), outDir);
      if (inside(output)) outputs.push(output);
    }
  }
  // Preserve TS's implicit-directory rule: a basename containing a dot stays a file spec.
  const normalize = (pattern: string): string => {
    const slashes = pattern.replaceAll("\\", "/");
    if (slashes === path.parse(slashes).root) return slashes;
    return slashes.replace(/\/+$/, "") || (slashes.startsWith("/") ? "/" : "");
  };
  config.exclude = config.exclude?.map(normalize);
  config.include = config.include?.map(normalize);
  const caseSensitive = !createFilesMatcher({
    path: configFile,
    config: { include: ["__mf_case_probe__.ts"] },
  })(path.join(path.dirname(configFile), "__MF_CASE_PROBE__.ts"));
  const matches = createFilesMatcher(
    {
      path: hasConfig ? configFile : path.join(root, "tsconfig.json"),
      config,
    },
    caseSensitive,
  );
  const explicit = new Set((config.files ?? []).map((file) => path.resolve(configDirectory, file)));
  const names = [...explicit];
  const absolutePattern = (pattern: string): string =>
    path.resolve(configDirectory, pattern).split(path.sep).join("/");
  const escape = (absolute: string): string => {
    let base = configDirectory;
    let relative = path.relative(base, absolute);
    while (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      base = path.dirname(base);
      relative = path.relative(base, absolute);
    }
    if (path.isAbsolute(relative)) {
      base = path.parse(absolute).root;
      relative = path.relative(base, absolute);
    }
    if (!relative) return glob.convertPathToPattern(base);
    const pattern = glob.posix
      .escapePath(relative.split(path.sep).join("/"))
      .replace(/\\([*?])/g, (_match, wildcard: string) => (wildcard === "?" ? "[^/]" : "*"));
    return `${glob.convertPathToPattern(base).replace(/\/$/, "")}/${pattern}`;
  };
  const includes = config.include ?? (config.files ? [] : ["**/*"]);
  if (includes.length) {
    // TS skips package directories only in wildcard segments; a literal include can opt in.
    const implicitDirectories = new Set(["bower_components", "jspm_packages"]);
    const explicitDirectories = includes.flatMap((pattern) => {
      const parts = absolutePattern(pattern).split("/");
      return parts.flatMap((part, index) =>
        implicitDirectories.has(caseSensitive ? part : part.toLowerCase())
          ? [
              createFilesMatcher(
                {
                  path: hasConfig ? configFile : path.join(root, "tsconfig.json"),
                  config: { include: [`${parts.slice(0, index + 1).join("/")}/*`], exclude: [] },
                },
                caseSensitive,
              ),
            ]
          : [],
      );
    });
    const patterns = includes.map((pattern) => {
      const absolute = absolutePattern(pattern);
      return escape(/(?:^|\/)[^.*?]+$/.test(absolute) ? `${absolute}/**/*` : absolute);
    });
    const excludes = (config.exclude ?? []).map(absolutePattern);
    const ignore = [
      ...excludes.flatMap((pattern) => [escape(pattern), escape(`${pattern}/**`)]),
      ...outputs.flatMap((output) => {
        const pattern = glob.convertPathToPattern(output);
        return [pattern, `${pattern}/**`];
      }),
      "**/node_modules/**",
      "**/.git/**",
    ];
    // fast-glob does not prune a directory when an ignore basename contains a wildcard.
    const ignoredDirectories = ignore.map((pattern) =>
      micromatch.matcher(pattern, {
        dot: true,
        nobrace: true,
        noext: true,
        nonegate: true,
        nocase: !caseSensitive,
      }),
    );
    const candidates = glob
      .sync(patterns, {
        cwd: root,
        absolute: true,
        dot: true,
        followSymbolicLinks: false,
        braceExpansion: false,
        extglob: false,
        caseSensitiveMatch: caseSensitive,
        ignore,
        fs: {
          readdirSync: ((directory: string, options?: { withFileTypes: true }) => {
            try {
              const full = path.resolve(directory);
              if (
                !ownPath(full) ||
                (full !== root &&
                  implicitDirectories.has(
                    caseSensitive ? path.basename(full) : path.basename(full).toLowerCase(),
                  ) &&
                  !explicitDirectories.some((match) =>
                    match(path.join(full, "__mf_directory__.ts")),
                  )) ||
                ignoredDirectories.some((match) => match(full.split(path.sep).join("/")))
              )
                return [];
              return options ? fs.readdirSync(directory, options) : fs.readdirSync(directory);
            } catch (error) {
              if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
                return [];
              throw error;
            }
          }) as glob.FileSystemAdapter["readdirSync"],
        },
      })
      .filter((file) => ownFile(file) && matches(file));
    const canonical = (file: string): string => (caseSensitive ? file : file.toLowerCase());
    const selected = new Set([...names, ...candidates].map(canonical));
    names.push(
      ...candidates.filter(
        (file) => !file.endsWith(".tsx") || !selected.has(canonical(`${file.slice(0, -4)}.ts`)),
      ),
    );
  }
  const files: SourceEntry[] = [];
  for (const full of [...new Set(names.map((file) => path.resolve(file)))].sort()) {
    if (!ownFile(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    files.push({
      name: path.relative(root, full).split(path.sep).join("/"),
      fullPath: path.join(folderPath, path.relative(root, full)),
      savedAt: stat.mtimeMs,
      size: stat.size,
    });
  }
  return files;
}
