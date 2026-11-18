import fs from "node:fs";
import path from "node:path";
import type * as t from "@babel/types";
import { noLog } from "../../../shared/config/logging.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import { canonicalPathIsInside, pathIsInside } from "../../../shared/lib/paths.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { AMBIGUOUS, SOURCE_EXTS } from "../config/config-imports.ts";
import type { ExportedValue, JsonValue, ResolvedExport } from "../models/config-imports.ts";
import type { AstPath, Program } from "../models/syntax.ts";
import type { ConfigDirectory, ConfigInput } from "../models/config.ts";
import { CONFIG_INPUT_LIMIT, readConfigDirectory, readConfigInput } from "./config-input.ts";
import { DOTENV_NAME } from "./scoped-dotenv.ts";
import { hasMemberWrites, parseProgram } from "./syntax.ts";

const MAX_HELPER_SOURCE_BYTES = 2 * CONFIG_INPUT_LIMIT;
const MAX_EXPLICIT_DOTENV_READS = 8;
const MIN_HELPER_COST = 1024;

// Per-discovery lifetime: no stale scopes or file contents survive a config reload.
export class ConfigImports {
  private readonly modules = new Map<string, Program | null>();
  private readonly json = new Map<string, JsonValue | undefined>();
  private readonly exportMemo = new Map<string, ResolvedExport | null>();
  private readonly resolvedFiles = new Map<string, string>();
  private entryRealPath: string | null | undefined;
  private remainingHelperBytes = MAX_HELPER_SOURCE_BYTES;
  private remainingExports = 2048;
  private exportCutoffs = 0;
  private readonly owners = new Map<t.Program, string>();
  readonly entry: Program;
  private readonly dependencies: Set<string> | undefined;
  private readonly log: LogContext;
  private readonly allowLocalEnv: boolean;
  private readonly inputs?: Map<string, ConfigInput>;
  private envDirectory?: ConfigDirectory;
  private readonly envTexts = new Map<string, string | null>();
  constructor(
    entry: Program,
    dependencies?: Set<string>,
    log: LogContext = noLog,
    allowLocalEnv = true,
    inputs?: Map<string, ConfigInput>,
    envDirectory?: ConfigDirectory,
  ) {
    this.entry = entry;
    this.dependencies = dependencies;
    this.log = log;
    this.allowLocalEnv = allowLocalEnv;
    this.inputs = inputs;
    this.envDirectory = envDirectory;
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
  sourcePosition(p: AstPath): string | undefined {
    if (p.node.start == null) return;
    const file = this.fileOf(p);
    let real = this.resolvedFiles.get(file);
    if (!real && file === this.entry.file) {
      if (this.entryRealPath === undefined) {
        try {
          this.entryRealPath = fs.realpathSync.native(file);
        } catch {
          this.entryRealPath = null;
        }
      }
      real = this.entryRealPath ?? undefined;
    }
    if (real) return `${real}\0${p.node.start}`;
  }
  readEnvText(file: string): string | null {
    if (
      !this.allowLocalEnv ||
      !path.isAbsolute(file) ||
      path.dirname(file) !== path.dirname(path.resolve(this.entry.file))
    )
      return null;
    if (!DOTENV_NAME.test(path.basename(file))) return null;
    const cached = this.envTexts.get(file);
    if (cached !== undefined) return cached;
    if (this.envTexts.size === MAX_EXPLICIT_DOTENV_READS) return null;
    this.dependencies?.add(file);
    this.envDirectory ??= readConfigDirectory(path.dirname(file));
    const text = this.envDirectory
      ? readConfigInput(file, 64 * 1024, {
          inputs: this.inputs,
          expectedDirectory: this.envDirectory,
        })
      : null;
    this.envTexts.set(file, text);
    return text;
  }
  readJson(from: AstPath, specifier: string): JsonValue | undefined {
    try {
      const resolved = resolveSpecifier(
        this.fileOf(from),
        specifier,
        this.dependencies,
        this.inputs,
      );
      if (!resolved || path.extname(resolved.file) !== ".json") return undefined;
      const file = resolved.file;
      if (this.json.has(file)) return this.json.get(file);
      if (!fs.lstatSync(file).isFile()) return undefined;
      const text = this.readHelperSource(file, resolved.real, 256 * 1024);
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
    return this.resolveModule(from, specifier)?.program ?? null;
  }
  private readHelperSource(
    file: string,
    canonical: string,
    limit: number,
    onError?: (error: unknown) => void,
  ) {
    if (this.remainingHelperBytes < MIN_HELPER_COST) return null;
    return readConfigInput(canonical, Math.min(limit, this.remainingHelperBytes - 1), {
      onError,
      lookup: file,
      expectedPath: canonical,
      inputs: this.inputs,
      reserveBytes: (size) => {
        // Count rejected in-flight reads and the overhead of tiny modules.
        this.remainingHelperBytes -= Math.max(MIN_HELPER_COST, size);
      },
    });
  }
  private resolveModule(from: AstPath, specifier: string) {
    let file: string | null = null;
    try {
      const resolved = resolveSpecifier(
        this.fileOf(from),
        specifier,
        this.dependencies,
        this.inputs,
      );
      if (!resolved) {
        this.log.event("trace", "config.helper.unresolved", {
          file: this.fileOf(from),
          reason: "missing-or-unconfined-import",
        });
        return null;
      }
      file = resolved.file;
      const previous = this.resolvedFiles.get(file);
      if (previous && previous !== resolved.real) return null;
      this.resolvedFiles.set(file, resolved.real);
      if (this.modules.has(file)) return { ...resolved, program: this.modules.get(file) ?? null };
      this.dependencies?.add(file);
      this.dependencies?.add(resolved.real);
      const source = this.readHelperSource(file, resolved.real, CONFIG_INPUT_LIMIT, (error) => {
        this.log.event("trace", "config.helper.unresolved", {
          file,
          reason: "unreadable-helper",
          ...safeError(error),
        });
      });
      const program = source === null ? null : parseProgram(source, file, this.log);
      this.modules.set(file, program);
      if (program) this.remember(program);
      return { ...resolved, program };
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
  addOwnershipSources(sources: Set<string>): void {
    for (const [file, real] of this.resolvedFiles) {
      sources.add(file);
      sources.add(real);
    }
  }
  federationFiles(files: ReadonlySet<string>): string[] {
    const matches = (file: string) => path.basename(file).startsWith("module-federation.config.");
    const found = new Set<string>();
    for (const file of files) {
      const real = this.resolvedFiles.get(file);
      if (!real || found.has(real) || (!matches(file) && !matches(real))) continue;
      found.add(real);
    }
    return [...found];
  }
  exported(program: Program, name: string): ResolvedExport | null {
    const value = this.resolveExport(program, name, new Set());
    return value === AMBIGUOUS ? null : value;
  }
  private resolveExport(
    program: Program,
    name: string,
    active: Set<string>,
  ): ResolvedExport | typeof AMBIGUOUS | null {
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
  ): ResolvedExport | typeof AMBIGUOUS | null {
    const exported = program.exports.get(name);
    if (exported) {
      if ("from" in exported) {
        const target = this.resolve(program.root, exported.from);
        const result = target && this.resolveExport(target, exported.imported, next);
        return result && result !== AMBIGUOUS
          ? { value: result.value, files: [program.file, ...result.files] }
          : result;
      }
      // Local import aliases must pass the evaluator's binding/write guards before forwarding.
      return { value: exported, files: [program.file] };
    }
    // Evaluate the final CJS object before selecting a named value: spreads and last-wins matter.
    if (name !== "default" && program.commonJs && program.default)
      return { value: { object: program.default, imported: name }, files: [program.file] };
    if (name === "default") return null;
    let match: ResolvedExport | null = null;
    for (const specifier of new Set(program.stars)) {
      const target = this.resolve(program.root, specifier);
      const result = target && this.resolveExport(target, name, next);
      if (!result) continue;
      if (
        result === AMBIGUOUS ||
        (match &&
          !sameExport(
            this.exportIdentity(match.value, next),
            this.exportIdentity(result.value, next),
          ))
      )
        return AMBIGUOUS;
      match = result;
    }
    return match && { value: match.value, files: [program.file, ...match.files] };
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
      value = original.value;
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
  inputs?: Map<string, ConfigInput>,
): { file: string; real: string } | null {
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
  const packageDir = packageRoot(fromFile, dependencies, inputs);
  const root = fs.realpathSync.native(packageDir);
  for (const candidate of candidates) {
    dependencies?.add(candidate); // Missing higher-priority files affect resolution too.
    let isFile = false;
    try {
      isFile = fs.statSync(candidate).isFile();
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (!isFile) {
      if (inputs && !inputs.has(candidate) && pathIsInside(packageDir, candidate))
        inputs.set(candidate, { file: candidate, resolutionRoot: root });
      continue;
    }
    const real = fs.realpathSync.native(candidate);
    if (!canonicalPathIsInside(root, real) || real.split(path.sep).includes("node_modules"))
      return null;
    return { file: path.resolve(candidate), real };
  }
  return null;
}

function packageRoot(
  file: string,
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
): string {
  const folder = path.dirname(path.resolve(file));
  const manifests: string[] = [];
  let dir = folder;
  while (true) {
    const packageFile = path.join(dir, "package.json");
    dependencies?.add(packageFile);
    if (inputs) manifests.push(packageFile);
    if (fs.existsSync(packageFile)) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = folder;
      break;
    }
    dir = parent;
  }
  if (inputs)
    for (const manifest of manifests) {
      if (pathIsInside(dir, manifest) && !inputs.has(manifest))
        inputs.set(manifest, { file: manifest, packageBoundary: true });
    }
  return dir;
}
