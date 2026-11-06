import fs from "node:fs";
import path from "node:path";
import type * as t from "@babel/types";
import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import { hasMemberWrites, parseProgram, type AstPath, type Program } from "./syntax.ts";
import { readConfigInput } from "./config-input.ts";

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export type ExportedValue = AstPath | { object: AstPath; imported: string };
const AMBIGUOUS = Symbol("ambiguous-export");
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Per-discovery lifetime: no stale scopes or file contents survive a config reload.
export class ConfigImports {
  private readonly modules = new Map<string, Program | null>();
  private readonly json = new Map<string, JsonValue | undefined>();
  private readonly exportMemo = new Map<string, ExportedValue | null>();
  private remainingExports = 2048;
  private exportCutoffs = 0;
  private readonly owners = new Map<t.Program, string>();
  readonly entry: Program;
  private readonly dependencies: Set<string> | undefined;
  private readonly log: LogContext;
  constructor(entry: Program, dependencies?: Set<string>, log: LogContext = noLog) {
    this.entry = entry;
    this.dependencies = dependencies;
    this.log = log;
    this.remember(entry);
  }
  private remember(program: Program): void {
    this.modules.set(path.resolve(program.file), program);
    this.owners.set(program.root.node, program.file);
  }
  fileOf(p: AstPath): string {
    const root = p.isProgram() ? p : p.findParent((parent) => parent.isProgram());
    return root ? (this.owners.get(root.node as t.Program) ?? this.entry.file) : this.entry.file;
  }
  readEnvText(file: string): string | null {
    if (
      !path.isAbsolute(file) ||
      path.dirname(file) !== path.dirname(path.resolve(this.entry.file))
    )
      return null;
    if (!/^\.env(?:\.[\w-]+)*$/.test(path.basename(file))) return null;
    this.dependencies?.add(file);
    return readConfigInput(file, 64 * 1024);
  }
  readJson(from: AstPath, specifier: string): JsonValue | undefined {
    try {
      const file = resolveSpecifier(this.fileOf(from), specifier, this.dependencies);
      if (!file || path.extname(file) !== ".json") return undefined;
      if (this.json.has(file)) return this.json.get(file);
      const text = readConfigInput(file, 256 * 1024);
      let value: JsonValue | undefined;
      if (text !== null) {
        value = JSON.parse(text.replace(/^\uFEFF/, ""), (_key, item: unknown) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.assign(Object.create(null), item)
            : item,
        ) as JsonValue;
      }
      this.json.set(file, value);
      return value;
    } catch {
      return undefined;
    }
  }
  resolve(from: AstPath, specifier: string): Program | null {
    let file: string | null = null;
    try {
      file = resolveSpecifier(this.fileOf(from), specifier, this.dependencies);
      if (!file) {
        this.log.event("trace", "config.helper.unresolved", {
          file: this.fileOf(from),
          reason: "missing-or-unconfined-import",
        });
        return null;
      }
      if (this.modules.has(file)) return this.modules.get(file) ?? null;
      this.dependencies?.add(file);
      const program = parseProgram(fs.readFileSync(file, "utf8"), file, this.log);
      this.modules.set(file, program);
      if (program) this.remember(program);
      return program;
    } catch (error) {
      if (file) this.modules.set(file, null);
      this.log.event("trace", "config.helper.unresolved", {
        file: file ?? this.fileOf(from),
        reason: "unreadable-helper",
        ...safeError(error),
      });
      return null;
    }
  }
  exported(program: Program, name: string): ExportedValue | null {
    const value = this.resolveExport(program, name, new Set());
    return value === AMBIGUOUS ? null : value;
  }
  private resolveExport(
    program: Program,
    name: string,
    active: Set<string>,
  ): ExportedValue | typeof AMBIGUOUS | null {
    const key = `${program.file}\0${name}`;
    if (active.has(key) || active.size > 8) {
      this.exportCutoffs++;
      this.log.event("trace", "config.helper.unresolved", {
        file: program.file,
        reason: "import-cycle-or-depth",
      });
      return active.has(key) ? null : AMBIGUOUS;
    }
    if (this.exportMemo.has(key)) return this.exportMemo.get(key) ?? null;
    if (this.remainingExports-- <= 0) return AMBIGUOUS;
    const cutoffs = this.exportCutoffs;
    const result = this.resolveExportFrom(program, name, new Set(active).add(key));
    if (result !== AMBIGUOUS && this.exportCutoffs === cutoffs) this.exportMemo.set(key, result);
    return result;
  }
  private resolveExportFrom(
    program: Program,
    name: string,
    next: Set<string>,
  ): ExportedValue | typeof AMBIGUOUS | null {
    const exported = program.exports.get(name);
    if (exported) {
      if ("from" in exported) {
        const target = this.resolve(program.root, exported.from);
        return target ? this.resolveExport(target, exported.imported, next) : null;
      }
      // Local import aliases must pass the evaluator's binding/write guards before forwarding.
      return exported;
    }
    // Evaluate the final CJS object before selecting a named value: spreads and last-wins matter.
    if (name !== "default" && program.commonJs && program.default)
      return { object: program.default, imported: name };
    if (name === "default") return null;
    let match: ExportedValue | null = null;
    for (const source of new Set(program.stars)) {
      const target = this.resolve(program.root, source);
      const result = target && this.resolveExport(target, name, next);
      if (!result) continue;
      if (
        result === AMBIGUOUS ||
        (match && !sameExport(this.exportIdentity(match, next), this.exportIdentity(result, next)))
      )
        return AMBIGUOUS;
      match = result;
    }
    return match;
  }
  private exportIdentity(value: ExportedValue, active: Set<string>): ExportedValue {
    const seen = new Set<t.Node>();
    while (!("object" in value) && value.isIdentifier() && !seen.has(value.node) && seen.size < 8) {
      seen.add(value.node);
      const binding = value.scope.getBinding(value.node.name);
      if (!binding?.constant || hasMemberWrites(binding)) break;
      const declaration = binding.path;
      if (!declaration.isImportSpecifier() && !declaration.isImportDefaultSpecifier()) break;
      const imported = declaration.isImportDefaultSpecifier()
        ? "default"
        : declaration.node.imported.type === "Identifier"
          ? declaration.node.imported.name
          : declaration.node.imported.value;
      const source = (declaration.parent as t.ImportDeclaration).source.value;
      const target = this.resolve(declaration, source);
      const original = target && this.resolveExport(target, imported, active);
      if (!original || original === AMBIGUOUS) break;
      value = original;
    }
    return value;
  }
}

function sameExport(left: ExportedValue, right: ExportedValue): boolean {
  if ("object" in left || "object" in right)
    return (
      "object" in left &&
      "object" in right &&
      left.object.node === right.object.node &&
      left.imported === right.imported
    );
  if (left.node === right.node) return true;
  if (!left.isIdentifier() || !right.isIdentifier()) return false;
  const binding = left.scope.getBinding(left.node.name);
  return binding !== undefined && binding === right.scope.getBinding(right.node.name);
}

function resolveSpecifier(
  fromFile: string,
  spec: string,
  dependencies?: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const ext = path.extname(spec);
  const candidates =
    !ext || ext === ".config"
      ? [
          ...(ext ? [base] : []),
          ...SOURCE_EXTS.map((suffix) => base + suffix),
          ...SOURCE_EXTS.map((suffix) => path.join(base, `index${suffix}`)),
        ]
      : /\.[cm]?jsx?$/.test(ext)
        ? [
            base.replace(/\.[cm]?jsx?$/, ext === ".cjs" ? ".cts" : ext === ".mjs" ? ".mts" : ".ts"),
            ...(ext === ".js" || ext === ".jsx" ? [base.replace(/\.jsx?$/, ".tsx")] : []),
            base,
          ]
        : [base];
  const root = fs.realpathSync(packageRoot(fromFile, dependencies));
  for (const candidate of candidates) {
    dependencies?.add(candidate); // Missing higher-priority files affect resolution too.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    const real = fs.realpathSync(candidate);
    const relative = path.relative(root, real);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      real.split(path.sep).includes("node_modules")
    )
      return null;
    return path.resolve(candidate);
  }
  return null;
}
function packageRoot(file: string, dependencies?: Set<string>): string {
  let dir = path.dirname(path.resolve(file));
  while (true) {
    const packageFile = path.join(dir, "package.json");
    dependencies?.add(packageFile);
    if (fs.existsSync(packageFile)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(path.resolve(file));
    dir = parent;
  }
}
