import fs from "node:fs";
import path from "node:path";
import type * as t from "@babel/types";
import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import { parseProgram, type AstPath, type Program } from "./syntax.ts";

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Per-discovery lifetime: no stale scopes or file contents survive a config reload.
export class ConfigImports {
  private readonly modules = new Map<string, Program | null>();
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
  exported(program: Program, name: string, active = new Set<string>()): AstPath | null {
    const key = `${program.file}\0${name}`;
    if (active.has(key) || active.size > 8) {
      this.log.event("trace", "config.helper.unresolved", {
        file: program.file,
        reason: "import-cycle-or-depth",
      });
      return null;
    }
    const next = new Set(active).add(key);
    const exported = program.exports.get(name);
    if (exported) {
      if ("from" in exported) {
        const target = this.resolve(program.root, exported.from);
        return target ? this.exported(target, exported.imported, next) : null;
      }
      if (exported.isIdentifier()) {
        const binding = exported.scope.getBinding(exported.node.name);
        const declaration = binding?.path;
        if (declaration?.isImportSpecifier() || declaration?.isImportDefaultSpecifier()) {
          const target = this.resolve(
            declaration,
            (declaration.parent as t.ImportDeclaration).source.value,
          );
          const imported = declaration.isImportDefaultSpecifier()
            ? "default"
            : declaration.node.imported.type === "Identifier"
              ? declaration.node.imported.name
              : declaration.node.imported.value;
          return target ? this.exported(target, imported, next) : null;
        }
      }
      return exported;
    }
    // A common CJS helper exports an object of named options/functions.
    if (program.default?.isObjectExpression()) {
      for (const prop of program.default.get("properties")) {
        if (
          prop.isObjectProperty() &&
          !prop.node.computed &&
          (prop.node.key.type === "Identifier"
            ? prop.node.key.name
            : prop.node.key.type === "StringLiteral"
              ? prop.node.key.value
              : null) === name
        )
          return prop.get("value");
      }
    }
    for (const source of program.stars) {
      const target = this.resolve(program.root, source);
      const result = target && this.exported(target, name, next);
      if (result) return result;
    }
    return null;
  }
}

function resolveSpecifier(
  fromFile: string,
  spec: string,
  dependencies?: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const ext = path.extname(spec);
  const candidates = !ext
    ? [
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
