import fs from "node:fs";
import path from "node:path";

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

// Own .ts/.tsx from the producer's tsconfig. Downloaded types and emit directories are not sources.
export function sourceSnapshot(
  folder: string,
  tsconfig: string | null,
  typesFolder: string,
): SourceSnapshot {
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
  const files: Array<SourceFile & { savedAt: number }> = [];
  if (!config.hasInclude) walk(root, root, skip, excluded, files);
  else {
    for (const item of config.include)
      collectIncluded(root, item.base, item.pattern, skip, excluded, files);
  }
  const unique = [...new Map(files.map((file) => [file.name, file])).values()];
  let savedAt: number | null = null;
  for (const file of unique) {
    if (savedAt == null || file.savedAt > savedAt) savedAt = file.savedAt;
  }
  return { savedAt, files: unique.map((file) => ({ name: file.name, bytes: file.bytes })) };
}

function collectIncluded(
  root: string,
  base: string,
  pattern: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  files: Array<SourceFile & { savedAt: number }>,
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
  const matched: string[] = [];
  walkPaths(start, (full) => {
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
  files: Array<SourceFile & { savedAt: number }>,
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
      bytes: new Uint8Array(fs.readFileSync(full)),
      savedAt: saved.mtimeMs,
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

function walkPaths(dir: string, visit: (full: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPaths(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

function addFile(
  root: string,
  full: string,
  skip: ReadonlySet<string>,
  excluded: (full: string) => boolean,
  files: Array<SourceFile & { savedAt: number }>,
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
    bytes: new Uint8Array(fs.readFileSync(full)),
    savedAt: saved.mtimeMs,
  });
}
