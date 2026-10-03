import fs from "node:fs";
import path from "node:path";
import { parseProgram, objectAst, type Ast, type Program } from "./syntax.ts";

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"];

interface Loaded {
  file: string;
  options: Ast;
  bindings: Map<string, Ast>;
}

export function loadCallee(filePath: string, parsed: Program, callee: string): Loaded | null {
  const local = objectAst(parsed.bindings.get(callee));
  if (local) return { file: filePath, options: local, bindings: parsed.bindings };
  const imported = parsed.imports.get(callee);
  if (!imported?.from.startsWith(".")) return null;
  const resolved = resolveSpecifier(filePath, imported.from);
  if (!resolved) return null;
  const exported = imported.exported === "*" ? callee : imported.exported;
  return resolveExport(resolved, exported, 0, new Set([path.resolve(filePath)]));
}

function resolveExport(
  file: string,
  exportName: string,
  depth: number,
  seen: Set<string>,
): Loaded | null {
  const resolved = path.resolve(file);
  if (depth > 8 || seen.has(resolved)) return null;
  seen.add(resolved);
  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
  const parsed = parseProgram(text);
  const options = objectAst(parsed.bindings.get(exportName));
  if (options) return { file: resolved, options, bindings: parsed.bindings };
  for (const rex of parsed.reexports) {
    if (rex.exported !== exportName || !rex.from) continue;
    const next = resolveSpecifier(resolved, rex.from);
    if (!next) continue;
    return resolveExport(next, rex.local, depth + 1, seen);
  }
  for (const spec of parsed.starFrom) {
    const next = resolveSpecifier(resolved, spec);
    if (!next) continue;
    const found = resolveExport(next, exportName, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates =
    path.extname(spec) === ""
      ? [
          ...SOURCE_EXTS.map((ext) => base + ext),
          ...SOURCE_EXTS.map((ext) => path.join(base, `index${ext}`)),
        ]
      : [base];
  const root = packageRoot(fromFile);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const real = fs.realpathSync(candidate);
    if (!isInside(fs.realpathSync(root), real)) return null;
    if (real.split(path.sep).includes("node_modules")) return null;
    return path.resolve(candidate);
  }
  return null;
}

function packageRoot(filePath: string): string {
  let dir = path.dirname(path.resolve(filePath));
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(path.resolve(filePath));
    dir = parent;
  }
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
