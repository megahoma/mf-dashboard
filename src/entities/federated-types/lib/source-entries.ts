import fs from "node:fs";
import path from "node:path";
import { createFilesMatcher, type TsConfigJsonResolved } from "get-tsconfig";
import picomatch from "picomatch";
import * as glob from "tinyglobby";
import { DEFAULT_TSCONFIG } from "../../../shared/config/project.ts";
import { isTypeScriptSource, pathIsInside } from "../../../shared/lib/paths.ts";
import { ROOT_OUTPUT_DIRS, SKIP_DIRS } from "../config/sources.ts";
import type { SourceEntry } from "../models/sources.ts";
import { readSourceConfig } from "./source-config.ts";

export function sourceEntries(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
  onConfig?: (config: TsConfigJsonResolved) => void,
): SourceEntry[] {
  const folderPath = path.resolve(folder);
  try {
    if (fs.lstatSync(folderPath).isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const root = fs.realpathSync(folderPath);
  let configFile = path.resolve(root, tsconfig?.trim() || DEFAULT_TSCONFIG);
  const inside = (file: string) => pathIsInside(root, file);
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
  const ownFile = (file: string): boolean => ownPath(file) && isTypeScriptSource(file);
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
  if (hasConfig) onConfig?.(config);
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
      path: hasConfig ? configFile : path.join(root, DEFAULT_TSCONFIG),
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
    const pattern = glob
      .escapePath(relative.split(path.sep).join("/"))
      .replace(/\\?([*?])/g, (_match, wildcard: string) => (wildcard === "?" ? "[^/]" : "*"));
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
                  path: hasConfig ? configFile : path.join(root, DEFAULT_TSCONFIG),
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
    // Prune skipped directories before reading them, including wildcard excludes.
    const ignoredDirectories = ignore.map((pattern) =>
      picomatch(pattern, {
        dot: true,
        nobrace: true,
        noext: true,
        nonegate: true,
        nocase: !caseSensitive,
      }),
    );
    // tinyglobby suppresses traversal errors; retain failures so incomplete scans cannot be saved.
    let scanError: unknown;
    // Merge overlapping roots without widening unrelated include roots to their common ancestor.
    const groups: { root: string; patterns: string[] }[] = [];
    for (const pattern of patterns) {
      const base = path.resolve(picomatch.scan(pattern, { unescape: true }).base);
      const parent = groups.find((group) => pathIsInside(group.root, base));
      if (parent) parent.patterns.push(pattern);
      else {
        const nested = groups.filter((group) => pathIsInside(base, group.root));
        for (const group of nested) groups.splice(groups.indexOf(group), 1);
        groups.push({
          root: base,
          patterns: [pattern, ...nested.flatMap((group) => group.patterns)],
        });
      }
    }
    const candidates = groups
      .flatMap((group) =>
        glob.globSync(group.patterns, {
          cwd: root,
          absolute: true,
          dot: true,
          followSymbolicLinks: false,
          expandDirectories: false,
          braceExpansion: false,
          extglob: false,
          caseSensitiveMatch: caseSensitive,
          fs: {
            readdirSync: ((directory: string, options?: { withFileTypes: true }) => {
              if (scanError) return [];
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
                return options ? fs.readdirSync(full, options) : fs.readdirSync(full);
              } catch (error) {
                if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
                  return [];
                scanError = error;
                throw error;
              }
            }) as glob.FileSystemAdapter["readdirSync"],
          },
        }),
      )
      .filter((file) => ownFile(file) && matches(file));
    if (scanError) throw scanError;
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
