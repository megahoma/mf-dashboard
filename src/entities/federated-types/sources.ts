import fs from "node:fs";
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

interface IncludePattern {
  base: string;
  pattern: string;
}

interface TsConfigInfo {
  outDir: IncludePattern | null;
  exclude: IncludePattern[];
  include: IncludePattern[];
  hasInclude: boolean;
}

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
): SourceIdentity {
  const entries = sourceEntries(folder, tsconfig, typesFolder);
  const stamp = entries
    .map((entry) => `${entry.name}\0${entry.size}\0${entry.savedAt}`)
    .sort()
    .join("\n");
  const key = `${path.resolve(folder)}\0${tsconfig ?? ""}\0${typesFolder}`;
  const hit = sourceCache.get(key);
  if (hit?.stamp === stamp) return { ...hit.identity, names: [...hit.identity.names] };
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

function sourceEntries(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
): SourceEntry[] {
  const root = path.resolve(folder);
  const config = readTsconfig(root, tsconfig);
  const skip = SKIP_DIRS;
  const outputPaths = [
    ...ROOT_OUTPUT_DIRS.map((name) => path.join(root, name)),
    ...(typesFolder ? [path.resolve(root, typesFolder)] : []),
    ...(config.outDir ? [path.resolve(config.outDir.base, config.outDir.pattern)] : []),
  ].filter((target) => isInside(root, target));
  const excluded = (full: string): boolean =>
    outputPaths.some((target) => full === target || full.startsWith(`${target}${path.sep}`)) ||
    config.exclude.some(({ base, pattern }) => {
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (rel === ".." || rel.startsWith("../")) return false;
      const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "");
      return /[*?]/.test(normalized)
        ? globMatch(normalized, rel)
        : rel === normalized || rel.startsWith(`${normalized}/`);
    });
  const pruneDirectory = (full: string): boolean =>
    outputPaths.some((target) => full === target || full.startsWith(`${target}${path.sep}`)) ||
    config.exclude.some(({ base, pattern }) => {
      const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "");
      if (/[*?]/.test(normalized)) return false;
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (rel === ".." || rel.startsWith("../")) return false;
      return rel === normalized || rel.startsWith(`${normalized}/`);
    });
  const files: SourceEntry[] = [];
  if (!config.hasInclude) walk(root, root, skip, excluded, files);
  else {
    for (const item of config.include)
      collectIncluded(root, item.base, item.pattern, skip, excluded, pruneDirectory, files);
  }
  const unique = [...new Map(files.map((file) => [file.name, file])).values()];
  return unique;
}

function collectIncluded(
  root: string,
  base: string,
  pattern: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  pruneDirectory: (full: string) => boolean,
  files: SourceEntry[],
): void {
  const normalized = pattern.replaceAll("\\", "/");
  if (!/[*?]/.test(normalized)) {
    const target = path.resolve(base, normalized);
    if (!isInside(root, target)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (
      fs.lstatSync(target).isSymbolicLink() ||
      !isInside(fs.realpathSync(root), fs.realpathSync(target))
    )
      return;
    if (stat.isDirectory()) walk(root, target, skip, excluded, files);
    else addFile(root, target, skip, excluded, files);
    return;
  }
  const prefix = normalized.split(/[*?]/)[0] ?? "";
  const start = path.resolve(base, prefix.endsWith("/") ? prefix : path.dirname(prefix));
  if (!isInside(root, start)) return;
  if (fs.existsSync(start) && !isInside(fs.realpathSync(root), fs.realpathSync(start))) return;
  if (
    pruneDirectory(start) ||
    path
      .relative(root, start)
      .split(path.sep)
      .some((part) => skip.has(part))
  )
    return;
  const matched: string[] = [];
  walkPaths(start, skip, pruneDirectory, (full) => {
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (globMatch(normalized, rel)) matched.push(full);
  });
  for (const full of matched) addFile(root, full, skip, excluded, files);
}

function walk(
  root: string,
  dir: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  files: SourceEntry[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skip.has(entry.name) || excluded(full)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(root, full, skip, excluded, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    const saved = fs.statSync(full);
    files.push({
      name: path.relative(root, full).split(path.sep).join("/"),
      fullPath: full,
      savedAt: saved.mtimeMs,
      size: saved.size,
    });
  }
}

function readTsconfig(folder: string, tsconfig: string | null): TsConfigInfo {
  const rel = tsconfig && tsconfig.trim() !== "" ? tsconfig : "tsconfig.json";
  return loadTsconfig(path.resolve(folder, rel), new Set());
}

function loadTsconfig(file: string, seen: Set<string>): TsConfigInfo {
  const empty: TsConfigInfo = { outDir: null, exclude: [], include: [], hasInclude: false };
  const resolved = path.resolve(file);
  if (seen.has(resolved) || !fs.existsSync(resolved)) return empty;
  seen.add(resolved);
  let json: {
    extends?: unknown;
    compilerOptions?: { outDir?: unknown };
    include?: unknown;
    exclude?: unknown;
  };
  try {
    const text = stripTrailingCommas(stripJsonComments(fs.readFileSync(resolved, "utf8")));
    json = JSON.parse(text) as typeof json;
  } catch {
    return empty;
  }
  const parent =
    typeof json.extends === "string" && json.extends !== ""
      ? loadTsconfig(resolveExtends(path.dirname(resolved), json.extends), seen)
      : empty;
  const ownInclude = stringList(json.include);
  const hasOwnInclude = Array.isArray(json.include);
  const include = hasOwnInclude
    ? ownInclude.map((pattern) => ({ base: path.dirname(resolved), pattern }))
    : parent.include;
  return {
    outDir:
      typeof json.compilerOptions?.outDir === "string"
        ? { base: path.dirname(resolved), pattern: json.compilerOptions.outDir }
        : parent.outDir,
    exclude: Array.isArray(json.exclude)
      ? stringList(json.exclude).map((pattern) => ({ base: path.dirname(resolved), pattern }))
      : parent.exclude,
    include,
    hasInclude: hasOwnInclude || parent.hasInclude,
  };
}

function stripJsonComments(text: string): string {
  let result = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      result += char;
      if (char === "\\") result += text[++i] ?? "";
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else result += char;
  }
  return result;
}

function stripTrailingCommas(text: string): string {
  let result = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      result += char;
      if (char === "\\") result += text[++i] ?? "";
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === "," && /[}\]]/.test(text.slice(i + 1).trimStart()[0] ?? "")) {
      continue;
    } else result += char;
  }
  return result;
}

function resolveExtends(fromDir: string, spec: string): string {
  const withExt = spec.endsWith(".json") ? spec : `${spec}.json`;
  return path.resolve(fromDir, withExt);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function globMatch(pattern: string, rel: string): boolean {
  const body = pattern
    .split("**/")
    .map((segment) =>
      segment
        .split("**")
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("*", "[^/]*")
            .replaceAll("?", "[^/]"),
        )
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${body}$`).test(rel);
}

function walkPaths(
  dir: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  visit: (full: string) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (skip.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (!excluded(full)) walkPaths(full, skip, excluded, visit);
    } else if (entry.isFile()) visit(full);
  }
}

function addFile(
  root: string,
  full: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  files: SourceEntry[],
): void {
  if (!isInside(root, full)) return;
  if (
    fs.lstatSync(full).isSymbolicLink() ||
    !isInside(fs.realpathSync(root), fs.realpathSync(full))
  )
    return;
  const rel = path.relative(root, full);
  if (rel.split(path.sep).some((part) => skip.has(part)) || excluded(full)) return;
  const name = path.basename(full);
  if (!name.endsWith(".ts") && !name.endsWith(".tsx")) return;
  if (name.endsWith(".d.ts")) return;
  const saved = fs.statSync(full);
  files.push({
    name: rel.split(path.sep).join("/"),
    fullPath: full,
    savedAt: saved.mtimeMs,
    size: saved.size,
  });
}
