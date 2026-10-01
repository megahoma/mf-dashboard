import fs from "node:fs";
import path from "node:path";

export interface LocalApp {
  name: string;
  folder: string;
  configFile: string;
  port: number | null;
  manifest: boolean;
  generateTypes: boolean;
  consumeTypes: boolean;
  typesFolder: string;
  tsconfig: string | null;
  manifestPath: string;
  compilerInstance: string | null;
  remotes: { alias: string; name: string; url: string | null }[];
}

export interface ScanOptions {
  ignorePaths?: readonly string[];
  envMode?: string;
}

const PLUGIN_NAMES = new Set([
  "pluginModuleFederation",
  "ModuleFederationPlugin",
  "createModuleFederationConfig",
]);
const CONFIG_FILE =
  /^(module-federation|webpack|rspack|rsbuild|vite)\.config\.(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)$/;
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist"]);
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"];

type Ast =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "ident"; v: string }
  | { k: "env"; key: string }
  | { k: "obj"; props: { key: string; value: Ast }[] }
  | { k: "mem"; obj: Ast; prop: Ast }
  | { k: "tpl"; parts: Array<{ k: "text"; v: string } | { k: "exp"; v: Ast }> }
  | { k: "bin"; op: "??" | "||"; left: Ast; right: Ast }
  | { k: "call"; calleeName: string }
  | { k: "fn"; returned: Ast | null }
  | { k: "other" };

interface PropAst {
  key: string;
  value: Ast;
}

interface Program {
  bindings: Map<string, Ast>;
  imports: Map<string, { from: string; exported: string }>;
  starFrom: string[];
  reexports: { local: string; exported: string; from?: string }[];
  pluginObject: Ast | null;
  pluginCallee: string | null;
  server: Ast | null;
  devServer: Ast | null;
}

interface Ctx extends Program {
  onReturn: ((ast: Ast) => void) | null;
}

type Val =
  | { t: "miss" }
  | { t: "null" }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "obj"; v: Record<string, Val> };

export function readEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  const parsed = parseProgram(source);
  let options = parsed.pluginObject?.k === "obj" ? parsed.pluginObject : null;
  let scope = parsed.bindings;
  // The generator imports configFile to obtain afterGenerate. Keep the file that
  // defines the federation options, not a rewritten copy of it.
  let configFile = filePath;
  if (!options && parsed.pluginCallee) {
    const loaded = loadCallee(filePath, parsed, parsed.pluginCallee);
    if (loaded?.options.k === "obj") {
      options = loaded.options;
      scope = loaded.bindings;
      configFile = loaded.file;
    }
  }
  if (!options) {
    const fallback = objectAst(parsed.bindings.get("default"));
    if (fallback && (isFederationFile(filePath) || federationShape(fallback))) options = fallback;
  }
  if (!options) return null;
  const name = asString(prop(options, "name"), scope, env);
  if (!name) return null;
  const dts = readDts(options, scope, env);
  const port =
    readPort(parsed.server, parsed.bindings, env) ??
    readPort(parsed.devServer, parsed.bindings, env);
  return {
    name,
    folder: path.dirname(filePath),
    configFile,
    port,
    manifest: flagOn(prop(options, "manifest"), scope, false),
    generateTypes: dts.generateTypes,
    consumeTypes: dts.consumeTypes,
    typesFolder: dts.typesFolder,
    tsconfig: dts.tsconfig,
    manifestPath: manifestPathOf(source, options, parsed.server, scope, env),
    compilerInstance: dts.compilerInstance,
    remotes: readRemotes(prop(options, "remotes"), scope, env),
  };
}

export function scanWorkspace(root: string, options: ScanOptions = {}): Record<string, LocalApp> {
  const found: Record<string, LocalApp> = {};
  const rootAbs = path.resolve(root);
  walk(rootAbs, rootAbs, options.ignorePaths ?? [], options.envMode ?? "development", found);
  return found;
}

function walk(
  dir: string,
  root: string,
  ignorePaths: readonly string[],
  envMode: string,
  found: Record<string, LocalApp>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const configs: string[] = [];
  const children: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (shouldSkip(entry.name, rel, ignorePaths)) continue;
      children.push(abs);
      continue;
    }
    if (entry.isFile() && CONFIG_FILE.test(entry.name)) configs.push(abs);
  }
  for (const app of discoverDirectory(dir, configs, envMode)) {
    if (!(app.name in found)) found[app.name] = app;
  }
  for (const child of children) walk(child, root, ignorePaths, envMode, found);
}

function shouldSkip(name: string, relPosix: string, extra: readonly string[]): boolean {
  if (ALWAYS_SKIP.has(name)) return true;
  for (const raw of extra) {
    const item = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (item === "") continue;
    if (!item.includes("/")) {
      if (name === item) return true;
      continue;
    }
    if (relPosix === item || relPosix.startsWith(`${item}/`)) return true;
  }
  return false;
}

function discoverDirectory(dir: string, files: string[], envMode: string): LocalApp[] {
  if (files.length === 0) return [];
  const env = readModeEnv(dir, envMode);
  const apps: LocalApp[] = [];
  let loosePort: number | null = null;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseProgram(text);
    const port =
      readPort(parsed.server, parsed.bindings, env) ??
      readPort(parsed.devServer, parsed.bindings, env);
    if (port !== null) loosePort = port;
    const app = discoverSource(text, file, env);
    if (!app) continue;
    const existing = apps.find((item) => item.name === app.name);
    if (!existing) apps.push(app);
    else if (existing.port === null && app.port !== null) existing.port = app.port;
  }
  if (apps.length === 1 && apps[0].port === null && loosePort !== null) apps[0].port = loosePort;
  return apps;
}

function readModeEnv(dir: string, mode: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!/^[A-Za-z0-9_-]+$/.test(mode)) return env;
  for (const name of [`.env.${mode}`, `.env.${mode}.local`]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    Object.assign(env, readEnvFile(fs.readFileSync(file, "utf8")));
  }
  return env;
}

function isFederationFile(filePath: string): boolean {
  return path.basename(filePath).startsWith("module-federation.config.");
}

function federationShape(obj: Ast): boolean {
  return ["name", "remotes", "exposes", "dts", "manifest", "filename"].some(
    (key) => prop(obj, key) !== undefined,
  );
}

interface Loaded {
  file: string;
  options: Ast;
  bindings: Map<string, Ast>;
}

function loadCallee(filePath: string, parsed: Program, callee: string): Loaded | null {
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

type ObjAst = Extract<Ast, { k: "obj" }>;

function objectAst(ast: Ast | undefined): ObjAst | null {
  if (ast?.k === "obj") return ast;
  if (ast?.k === "fn" && ast.returned?.k === "obj") return ast.returned;
  return null;
}

function prop(obj: Ast, key: string): Ast | undefined {
  if (obj.k !== "obj") return undefined;
  return obj.props.find((item) => item.key === key)?.value;
}

function readPort(
  obj: Ast | null,
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): number | null {
  if (!obj || obj.k !== "obj") return null;
  const value = evalAst(prop(obj, "port"), makeResolve(bindings, env), env);
  if (!value || (value.t !== "num" && value.t !== "str")) return null;
  const port = value.t === "num" ? value.v : /^\d+$/.test(value.v) ? Number(value.v) : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function flagOn(ast: Ast | undefined, bindings: Map<string, Ast>, whenMissing: boolean): boolean {
  if (!ast) return whenMissing;
  const value = ast.k === "ident" ? (bindings.get(ast.v) ?? ast) : ast;
  if (value.k === "bool") return value.v;
  if (value.k === "obj" || value.k === "fn") return true;
  return whenMissing;
}

function asString(
  ast: Ast | undefined,
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): string | null {
  const value = evalAst(ast, makeResolve(bindings, env), env);
  if (!value || value.t !== "str" || value.v === "") return null;
  return value.v;
}

function readDts(
  options: Ast,
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): {
  generateTypes: boolean;
  consumeTypes: boolean;
  typesFolder: string;
  tsconfig: string | null;
  compilerInstance: string | null;
} {
  const empty = {
    generateTypes: false,
    consumeTypes: false,
    typesFolder: "@mf-types",
    tsconfig: null,
    compilerInstance: null,
  };
  const dtsAst = prop(options, "dts");
  if (!dtsAst) return empty;
  const dts = dtsAst.k === "ident" ? (bindings.get(dtsAst.v) ?? dtsAst) : dtsAst;
  if (dts.k === "bool") {
    return dts.v ? { ...empty, generateTypes: true, consumeTypes: true } : empty;
  }
  if (dts.k !== "obj") return empty;
  const generateAst = prop(dts, "generateTypes");
  const consumeAst = prop(dts, "consumeTypes");
  const generateTypes = flagOn(generateAst, bindings, true);
  const consumeTypes = flagOn(consumeAst, bindings, true);
  const generateObj =
    generateAst && generateAst.k === "obj"
      ? generateAst
      : generateAst?.k === "ident"
        ? objectAst(bindings.get(generateAst.v))
        : null;
  const consumeObj =
    consumeAst && consumeAst.k === "obj"
      ? consumeAst
      : consumeAst?.k === "ident"
        ? objectAst(bindings.get(consumeAst.v))
        : null;
  let typesFolder = "@mf-types";
  let tsconfig: string | null = asString(prop(dts, "tsConfigPath"), bindings, env);
  let compilerInstance: string | null = null;
  if (generateTypes && generateObj?.k === "obj") {
    compilerInstance = asString(prop(generateObj, "compilerInstance"), bindings, env);
    tsconfig = asString(prop(generateObj, "tsConfigPath"), bindings, env) ?? tsconfig;
    typesFolder = asString(prop(generateObj, "typesFolder"), bindings, env) ?? typesFolder;
  }
  if (consumeTypes && consumeObj?.k === "obj") {
    typesFolder = asString(prop(consumeObj, "typesFolder"), bindings, env) ?? typesFolder;
  }
  return { generateTypes, consumeTypes, typesFolder, tsconfig, compilerInstance };
}

function manifestPathOf(
  source: string,
  options: Ast,
  server: Ast | null,
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): string {
  const manifest = prop(options, "manifest");
  const manifestObj = manifest?.k === "obj" ? manifest : null;
  const fileName =
    (manifestObj && asString(prop(manifestObj, "fileName"), bindings, env)) || "mf-manifest.json";
  let prefix = "";
  if (source.includes("import.meta.env.ASSET_PREFIX") && env.ASSET_PREFIX?.trim()) {
    const clean = env.ASSET_PREFIX.trim().replace(/^\/+|\/+$/g, "");
    if (clean) prefix = `/${clean}`;
  } else if (server?.k === "obj") {
    const base = asString(prop(server, "base"), bindings, env);
    if (base && base !== "/") {
      const clean = base.trim().replace(/^\/+|\/+$/g, "");
      if (clean) prefix = `/${clean}`;
    }
  }
  return `${prefix}/${fileName.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
}

function readRemotes(
  ast: Ast | undefined,
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): LocalApp["remotes"] {
  const obj = ast?.k === "obj" ? ast : ast?.k === "ident" ? objectAst(bindings.get(ast.v)) : null;
  if (!obj || obj.k !== "obj") return [];
  const resolve = makeResolve(bindings, env);
  return obj.props.map((item) => readRemote(item.key, item.value, resolve, env));
}

function readRemote(
  alias: string,
  ast: Ast,
  resolve: (name: string) => Val,
  env: Record<string, string>,
): LocalApp["remotes"][number] {
  if (ast.k === "obj") {
    const external = prop(ast, "external") ?? prop(ast, "entry");
    if (external) return readRemote(alias, external, resolve, env);
  }
  const parsed = evalRemote(ast, resolve, env);
  if (parsed.missing) return { alias, name: parsed.name ?? alias, url: null };
  return splitRemote(alias, parsed.text);
}

// A missing placeholder clears the URL. Keeping "http://${...}" or borrowing :3002 would invent a port.
function evalRemote(
  ast: Ast,
  resolve: (name: string) => Val,
  env: Record<string, string>,
): { missing: boolean; text: string; name: string | null } {
  if (ast.k !== "tpl") {
    const value = evalAst(ast, resolve, env);
    if (!value || value.t === "miss" || value.t === "null")
      return { missing: true, text: "", name: null };
    if (value.t === "str") return { missing: value.v.includes("${"), text: value.v, name: null };
    return { missing: true, text: "", name: null };
  }
  let text = "";
  let missing = false;
  let staticName = "";
  let sawAt = false;
  let dynamicName = false;
  for (const part of ast.parts) {
    if (part.k === "text") {
      text += part.v;
      if (!sawAt) {
        const at = part.v.indexOf("@");
        if (at >= 0) {
          staticName += part.v.slice(0, at);
          sawAt = true;
        } else staticName += part.v;
      }
      continue;
    }
    const value = evalAst(part.v, resolve, env);
    if (!value || value.t === "miss" || value.t === "null") {
      missing = true;
      if (!sawAt) dynamicName = true;
      continue;
    }
    if (value.t !== "str" && value.t !== "num" && value.t !== "bool") {
      missing = true;
      if (!sawAt) dynamicName = true;
      continue;
    }
    const chunk = String(value.v);
    text += chunk;
    if (!sawAt) {
      const at = chunk.indexOf("@");
      if (at >= 0) {
        staticName += chunk.slice(0, at);
        sawAt = true;
      } else {
        staticName += chunk;
        dynamicName = true;
      }
    }
  }
  const name = sawAt && !dynamicName && staticName !== "" ? staticName : null;
  return { missing, text, name };
}

function splitRemote(alias: string, raw: string): LocalApp["remotes"][number] {
  const at = raw.indexOf("@");
  if (at <= 0) return { alias, name: alias, url: raw.trim() || null };
  const name = raw.slice(0, at);
  const url = raw.slice(at + 1).trim();
  if (url === "" || url.includes("${")) return { alias, name, url: null };
  return { alias, name, url };
}

function makeResolve(
  bindings: Map<string, Ast>,
  env: Record<string, string>,
): (name: string) => Val {
  const cache = new Map<string, Val>();
  const stack = new Set<string>();
  return function resolve(name: string): Val {
    const cached = cache.get(name);
    if (cached) return cached;
    if (stack.has(name)) return { t: "miss" };
    const ast = bindings.get(name);
    if (!ast) return { t: "miss" };
    stack.add(name);
    const value = evalAst(ast, resolve, env) ?? { t: "miss" };
    stack.delete(name);
    cache.set(name, value);
    return value;
  };
}

function evalAst(
  ast: Ast | undefined,
  resolve: (name: string) => Val,
  env: Record<string, string>,
): Val | null {
  if (!ast) return null;
  switch (ast.k) {
    case "str":
      return { t: "str", v: ast.v };
    case "num":
      return { t: "num", v: ast.v };
    case "bool":
      return { t: "bool", v: ast.v };
    case "null":
      return { t: "null" };
    case "env":
      return Object.prototype.hasOwnProperty.call(env, ast.key)
        ? { t: "str", v: env[ast.key] }
        : { t: "miss" };
    case "ident":
      return resolve(ast.v);
    case "obj": {
      const value: Record<string, Val> = {};
      for (const item of ast.props) {
        const child = evalAst(item.value, resolve, env);
        if (child) value[item.key] = child;
      }
      return { t: "obj", v: value };
    }
    case "mem": {
      const key = evalAst(ast.prop, resolve, env);
      if (
        ast.obj.k === "mem" &&
        ast.obj.obj.k === "ident" &&
        ast.obj.obj.v === "process" &&
        ast.obj.prop.k === "str" &&
        ast.obj.prop.v === "env" &&
        key?.t === "str"
      )
        return Object.prototype.hasOwnProperty.call(env, key.v)
          ? { t: "str", v: env[key.v] }
          : { t: "miss" };
      const obj = evalAst(ast.obj, resolve, env);
      if (!obj || obj.t !== "obj" || !key || key.t !== "str") return { t: "miss" };
      return obj.v[key.v] ?? { t: "miss" };
    }
    case "bin": {
      const left = evalAst(ast.left, resolve, env);
      const missing = !left || left.t === "miss" || left.t === "null";
      if (ast.op === "??") return missing ? evalAst(ast.right, resolve, env) : left;
      const falsy =
        missing ||
        (left.t === "str" && left.v === "") ||
        (left.t === "bool" && !left.v) ||
        (left.t === "num" && left.v === 0);
      return falsy ? evalAst(ast.right, resolve, env) : left;
    }
    case "tpl": {
      let out = "";
      for (const part of ast.parts) {
        if (part.k === "text") {
          out += part.v;
          continue;
        }
        const value = evalAst(part.v, resolve, env);
        if (!value || value.t === "miss" || value.t === "null") return { t: "miss" };
        if (value.t === "obj") return { t: "miss" };
        out += String(value.v);
      }
      return { t: "str", v: out };
    }
    default:
      return { t: "miss" };
  }
}

class Cursor {
  i = 0;
  readonly s: string;

  constructor(source: string) {
    this.s = source;
  }

  get done(): boolean {
    return this.i >= this.s.length;
  }

  skipTrivia(): void {
    const s = this.s;
    while (this.i < s.length) {
      const ch = s[this.i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.i++;
        continue;
      }
      if (ch === "/" && s[this.i + 1] === "/") {
        this.i += 2;
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (ch === "/" && s[this.i + 1] === "*") {
        this.i += 2;
        while (this.i < s.length && !(s[this.i] === "*" && s[this.i + 1] === "/")) this.i++;
        if (this.i < s.length) this.i += 2;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipTrivia();
    return this.s[this.i] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.i++;
    return true;
  }

  startsWithIdent(word: string): boolean {
    this.skipTrivia();
    if (!this.s.startsWith(word, this.i)) return false;
    const after = this.s[this.i + word.length] ?? "";
    return !/[\w$]/.test(after);
  }

  ident(): string | null {
    this.skipTrivia();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!match) return null;
    this.i += match[0].length;
    return match[0];
  }
}

function parseProgram(source: string): Program {
  const ctx: Ctx = {
    bindings: new Map(),
    imports: new Map(),
    starFrom: [],
    reexports: [],
    pluginObject: null,
    pluginCallee: null,
    server: null,
    devServer: null,
    onReturn: null,
  };
  const cursor = new Cursor(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  while (!cursor.done) {
    const before = cursor.i;
    if (cursor.peek() === "" || cursor.peek() === "}") break;
    parseStatement(cursor, ctx);
    if (cursor.i <= before) cursor.i = before + 1;
  }
  return ctx;
}

function parseStatement(c: Cursor, ctx: Ctx): void {
  if (c.startsWithIdent("import") && c.s[c.i + "import".length] !== "(") {
    parseImport(c, ctx);
    return;
  }
  if (c.startsWithIdent("export")) {
    parseExport(c, ctx);
    return;
  }
  if (c.startsWithIdent("const") || c.startsWithIdent("let") || c.startsWithIdent("var")) {
    parseDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("function")) {
    parseFunctionDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("return")) {
    c.ident();
    const value = parseExpression(c, ctx);
    c.eat(";");
    ctx.onReturn?.(value);
    return;
  }
  if (
    c.startsWithIdent("interface") ||
    c.startsWithIdent("type") ||
    c.startsWithIdent("enum") ||
    c.startsWithIdent("namespace") ||
    c.startsWithIdent("declare") ||
    c.startsWithIdent("class")
  ) {
    skipLoose(c);
    return;
  }
  if (c.eat(";")) return;
  parseExpression(c, ctx);
  c.eat(";");
}

function parseImport(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.startsWithIdent("type")) c.ident();
  const named: { local: string; exported: string }[] = [];
  let defaultLocal: string | null = null;
  if (c.eat("*")) {
    if (c.startsWithIdent("as")) c.ident();
    const local = c.ident();
    if (c.startsWithIdent("from")) c.ident();
    const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
    if (local) ctx.imports.set(local, { from: spec, exported: "*" });
    c.eat(";");
    return;
  }
  if (c.peek() === "'" || c.peek() === '"') {
    parseString(c);
    c.eat(";");
    return;
  }
  if (c.peek() !== "{") {
    defaultLocal = c.ident();
    c.eat(",");
  }
  if (c.eat("{")) {
    while (!c.done && c.peek() !== "}") {
      if (c.startsWithIdent("type")) c.ident();
      const first = c.ident();
      if (!first) {
        c.i++;
        continue;
      }
      let local = first;
      if (c.startsWithIdent("as")) {
        c.ident();
        local = c.ident() ?? first;
      }
      named.push({ local, exported: first });
      c.eat(",");
    }
    c.eat("}");
  }
  if (c.startsWithIdent("from")) c.ident();
  const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
  if (defaultLocal) ctx.imports.set(defaultLocal, { from: spec, exported: "default" });
  for (const item of named) ctx.imports.set(item.local, { from: spec, exported: item.exported });
  c.eat(";");
}

function parseExport(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.startsWithIdent("type")) {
    c.ident();
    if (c.peek() === "{") {
      skipBalanced(c, "{", "}");
      if (c.startsWithIdent("from")) {
        c.ident();
        if (c.peek() === "'" || c.peek() === '"') parseString(c);
      }
      c.eat(";");
      return;
    }
    skipLoose(c);
    return;
  }
  if (c.startsWithIdent("default")) {
    c.ident();
    ctx.bindings.set("default", parseExpression(c, ctx));
    c.eat(";");
    return;
  }
  if (c.eat("*")) {
    const namespaced = c.startsWithIdent("as");
    if (namespaced) {
      c.ident();
      c.ident();
    }
    if (c.startsWithIdent("from")) c.ident();
    const spec = c.peek() === "'" || c.peek() === '"' ? parseString(c) : "";
    if (!namespaced && spec) ctx.starFrom.push(spec);
    c.eat(";");
    return;
  }
  if (c.eat("{")) {
    const names: { local: string; exported: string }[] = [];
    while (!c.done && c.peek() !== "}") {
      if (c.startsWithIdent("type")) c.ident();
      const first = c.ident();
      if (!first) {
        c.i++;
        continue;
      }
      let exported = first;
      if (c.startsWithIdent("as")) {
        c.ident();
        exported = c.ident() ?? first;
      }
      names.push({ local: first, exported });
      c.eat(",");
    }
    c.eat("}");
    let from: string | undefined;
    if (c.startsWithIdent("from")) {
      c.ident();
      if (c.peek() === "'" || c.peek() === '"') from = parseString(c);
    }
    for (const item of names) ctx.reexports.push({ ...item, from });
    c.eat(";");
    return;
  }
  if (c.startsWithIdent("const") || c.startsWithIdent("let") || c.startsWithIdent("var")) {
    parseDecl(c, ctx);
    return;
  }
  if (c.startsWithIdent("function")) {
    parseFunctionDecl(c, ctx);
    return;
  }
  skipLoose(c);
}

function parseDecl(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.peek() === "{") {
    skipBalanced(c, "{", "}");
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
    c.eat(";");
    return;
  }
  if (c.peek() === "[") {
    skipBalanced(c, "[", "]");
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
    c.eat(";");
    return;
  }
  const name = c.ident();
  if (!name) return;
  if (c.eat(":")) skipType(c);
  if (c.eat("=")) ctx.bindings.set(name, parseExpression(c, ctx));
  c.eat(";");
}

function parseFunctionDecl(c: Cursor, ctx: Ctx): void {
  c.ident();
  if (c.peek() === "*") c.i++;
  const name = c.ident();
  if (c.peek() === "<") skipAngles(c);
  if (c.peek() === "(") skipBalanced(c, "(", ")");
  if (c.eat(":")) skipType(c);
  const returned = c.peek() === "{" ? parseBlock(c, ctx) : null;
  if (name) ctx.bindings.set(name, { k: "fn", returned });
}

function parseBlock(c: Cursor, ctx: Ctx): Ast | null {
  let returned: Ast | null = null;
  const previous = ctx.onReturn;
  ctx.onReturn = (ast) => {
    returned = ast;
  };
  c.eat("{");
  while (!c.done && c.peek() !== "}") {
    const before = c.i;
    parseStatement(c, ctx);
    if (c.i <= before) c.i = before + 1;
  }
  c.eat("}");
  ctx.onReturn = previous;
  return returned;
}

function parseExpression(c: Cursor, ctx: Ctx): Ast {
  const expr = parseTernary(c, ctx);
  if (c.startsWithIdent("as") || c.startsWithIdent("satisfies")) {
    c.ident();
    skipType(c);
  }
  return expr;
}

function parseTernary(c: Cursor, ctx: Ctx): Ast {
  const test = parseNullish(c, ctx);
  if (c.peek() === "?" && c.s[c.i + 1] !== "." && c.s[c.i + 1] !== "?") {
    c.i++;
    parseTernary(c, ctx);
    if (!c.eat(":")) return test;
    parseTernary(c, ctx);
    return { k: "other" };
  }
  return test;
}

function parseNullish(c: Cursor, ctx: Ctx): Ast {
  let left = parseOr(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!c.s.startsWith("??", c.i)) break;
    c.i += 2;
    left = { k: "bin", op: "??", left, right: parseOr(c, ctx) };
  }
  return left;
}

function parseOr(c: Cursor, ctx: Ctx): Ast {
  let left = parseAnd(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!(c.s.startsWith("||", c.i) && c.s[c.i + 2] !== "|")) break;
    c.i += 2;
    left = { k: "bin", op: "||", left, right: parseAnd(c, ctx) };
  }
  return left;
}

function parseAnd(c: Cursor, ctx: Ctx): Ast {
  const left = parseUnary(c, ctx);
  while (true) {
    c.skipTrivia();
    if (!c.s.startsWith("&&", c.i)) break;
    c.i += 2;
    parseUnary(c, ctx);
  }
  return left;
}

function parseUnary(c: Cursor, ctx: Ctx): Ast {
  if (c.eat("!")) {
    parseUnary(c, ctx);
    return { k: "other" };
  }
  if (c.startsWithIdent("void") || c.startsWithIdent("typeof") || c.startsWithIdent("await")) {
    c.ident();
    parseUnary(c, ctx);
    return { k: "other" };
  }
  if (c.startsWithIdent("new")) {
    c.ident();
    const name = c.ident();
    if (name && c.peek() === "(") return parseCall(c, ctx, name);
    return { k: "other" };
  }
  return parsePrimary(c, ctx);
}

function parsePrimary(c: Cursor, ctx: Ctx): Ast {
  if (c.peek() === "/" && c.s[c.i + 1] !== "/" && c.s[c.i + 1] !== "*" && canStartRegex(c)) {
    skipRegex(c);
    return { k: "other" };
  }
  if (c.peek() === "'" || c.peek() === '"') return { k: "str", v: parseString(c) };
  if (c.peek() === "`") return parseTemplate(c, ctx);
  if (c.peek() === "{") return parseObject(c, ctx);
  if (c.peek() === "[") return parseArray(c, ctx);
  if (c.peek() === "(") return parseParenOrArrow(c, ctx);
  if (/\d/.test(c.peek())) return { k: "num", v: parseNumber(c) };
  const name = c.ident();
  if (!name) {
    if (!c.done) c.i++;
    return { k: "other" };
  }
  if (name === "true") return parsePostfix(c, ctx, { k: "bool", v: true });
  if (name === "false") return parsePostfix(c, ctx, { k: "bool", v: false });
  if (name === "null") return parsePostfix(c, ctx, { k: "null" });
  if (name === "import") return parseImportMeta(c, ctx);
  if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
  return parsePostfix(c, ctx, { k: "ident", v: name });
}

function parseImportMeta(c: Cursor, ctx: Ctx): Ast {
  if (!c.eat(".")) return { k: "other" };
  const meta = c.ident();
  if (meta !== "meta" || !c.eat(".")) return { k: "other" };
  const field = c.ident();
  if (field !== "env") return { k: "other" };
  if (c.eat(".")) {
    const key = c.ident();
    if (!key) return { k: "other" };
    return parsePostfix(c, ctx, { k: "env", key });
  }
  if (c.eat("[")) {
    const key = parseExpression(c, ctx);
    c.eat("]");
    if (key.k === "str") return { k: "env", key: key.v };
  }
  return { k: "other" };
}

function parsePostfix(c: Cursor, ctx: Ctx, ast: Ast): Ast {
  while (true) {
    if (c.peek() === "(") {
      ast = ast.k === "ident" ? parseCall(c, ctx, ast.v) : parseCall(c, ctx, "");
      continue;
    }
    if (c.peek() === "." && c.s[c.i + 1] !== ".") {
      c.i++;
      const name = c.ident();
      if (!name) break;
      ast = { k: "mem", obj: ast, prop: { k: "str", v: name } };
      continue;
    }
    c.skipTrivia();
    if (c.s.startsWith("?.", c.i)) {
      c.i += 2;
      if (c.eat("[")) {
        const key = parseExpression(c, ctx);
        c.eat("]");
        ast = { k: "mem", obj: ast, prop: key.k === "str" ? key : { k: "str", v: "" } };
        continue;
      }
      const name = c.ident();
      ast = { k: "mem", obj: ast, prop: { k: "str", v: name ?? "" } };
      continue;
    }
    if (c.eat("[")) {
      const key = parseExpression(c, ctx);
      c.eat("]");
      ast = { k: "mem", obj: ast, prop: key };
      continue;
    }
    break;
  }
  return ast;
}

function parseCall(c: Cursor, ctx: Ctx, calleeName: string): Ast {
  c.eat("(");
  const args: Ast[] = [];
  if (c.peek() !== ")" && !c.done) {
    args.push(parseExpression(c, ctx));
    while (c.eat(",")) {
      if (c.peek() === ")" || c.done) break;
      args.push(parseExpression(c, ctx));
    }
  }
  c.eat(")");
  rememberPlugin(ctx, calleeName, args[0]);
  return { k: "call", calleeName };
}

function rememberPlugin(ctx: Ctx, calleeName: string, arg: Ast | undefined): void {
  if (!PLUGIN_NAMES.has(calleeName) || !arg || ctx.pluginObject || ctx.pluginCallee) return;
  if (arg.k === "obj") ctx.pluginObject = arg;
  else if (arg.k === "call" && arg.calleeName) ctx.pluginCallee = arg.calleeName;
  else if (arg.k === "ident") ctx.pluginCallee = arg.v;
}

function parseObject(c: Cursor, ctx: Ctx): Ast {
  c.eat("{");
  const props: PropAst[] = [];
  while (!c.done && c.peek() !== "}") {
    const before = c.i;
    if (c.s.startsWith("...", c.i)) {
      c.i += 3;
      parseExpression(c, ctx);
      c.eat(",");
      continue;
    }
    let key: string;
    let value: Ast | null = null;
    if (c.peek() === "[") {
      c.eat("[");
      const computed = parseExpression(c, ctx);
      c.eat("]");
      key = computed.k === "str" ? computed.v : "";
      if (c.eat(":")) value = parseExpression(c, ctx);
    } else if (c.peek() === "'" || c.peek() === '"') {
      key = parseString(c);
      if (c.eat(":")) value = parseExpression(c, ctx);
    } else {
      const name = c.ident();
      if (!name) {
        c.i++;
        continue;
      }
      if (c.peek() === "(" || c.peek() === "<") {
        if (c.peek() === "<") skipAngles(c);
        parseCall(c, ctx, name);
        if (c.peek() === "{") skipBalanced(c, "{", "}");
        c.eat(",");
        continue;
      }
      key = name;
      value = c.eat(":") ? parseExpression(c, ctx) : { k: "ident", v: name };
    }
    if (key && value) {
      props.push({ key, value });
      if ((key === "server" || key === "devServer") && value.k === "obj" && prop(value, "port")) {
        if (key === "server" && !ctx.server) ctx.server = value;
        if (key === "devServer" && !ctx.devServer) ctx.devServer = value;
      }
    }
    c.eat(",");
    if (c.i <= before) c.i = before + 1;
  }
  c.eat("}");
  return { k: "obj", props };
}

function parseArray(c: Cursor, ctx: Ctx): Ast {
  c.eat("[");
  while (!c.done && c.peek() !== "]") {
    if (c.eat(",")) continue;
    parseExpression(c, ctx);
    c.eat(",");
  }
  c.eat("]");
  return { k: "other" };
}

function parseParenOrArrow(c: Cursor, ctx: Ctx): Ast {
  c.eat("(");
  if (c.peek() === ")") {
    c.i++;
    if (c.eat(":")) skipType(c);
    if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
    return { k: "other" };
  }
  const inner = parseExpression(c, ctx);
  if (c.eat(":")) skipType(c);
  while (c.eat(",")) {
    if (c.peek() === ")") break;
    if (c.peek() === "{") skipBalanced(c, "{", "}");
    else if (c.peek() === "[") skipBalanced(c, "[", "]");
    else c.ident();
    if (c.peek() === "?") c.i++;
    if (c.eat(":")) skipType(c);
    if (c.eat("=")) parseExpression(c, ctx);
  }
  if (!c.eat(")")) return inner;
  if (c.eat(":")) skipType(c);
  if (eatArrow(c)) return { k: "fn", returned: parseArrowBody(c, ctx) };
  return inner;
}

function parseArrowBody(c: Cursor, ctx: Ctx): Ast | null {
  if (c.peek() === "{") return parseBlock(c, ctx);
  return parseExpression(c, ctx);
}

function eatArrow(c: Cursor): boolean {
  c.skipTrivia();
  if (!c.s.startsWith("=>", c.i)) return false;
  c.i += 2;
  return true;
}

function parseTemplate(c: Cursor, ctx: Ctx): Ast {
  c.i++;
  const parts: Array<{ k: "text"; v: string } | { k: "exp"; v: Ast }> = [];
  let text = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      text += c.s[c.i + 1] ?? "";
      c.i += 2;
      continue;
    }
    if (ch === "`") {
      c.i++;
      parts.push({ k: "text", v: text });
      return { k: "tpl", parts };
    }
    if (ch === "$" && c.s[c.i + 1] === "{") {
      parts.push({ k: "text", v: text });
      text = "";
      c.i += 2;
      parts.push({ k: "exp", v: parseExpression(c, ctx) });
      if (c.s[c.i] === "}") c.i++;
      continue;
    }
    text += ch;
    c.i++;
  }
  parts.push({ k: "text", v: text });
  return { k: "tpl", parts };
}

function parseString(c: Cursor): string {
  const quote = c.s[c.i];
  if (quote !== "'" && quote !== '"') return "";
  c.i++;
  let out = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      const next = c.s[c.i + 1] ?? "";
      const escaped: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "`": "`",
      };
      out += escaped[next] ?? next;
      c.i += 2;
      continue;
    }
    if (ch === quote) {
      c.i++;
      return out;
    }
    out += ch;
    c.i++;
  }
  return out;
}

function parseNumber(c: Cursor): number {
  const match = /^(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?)/.exec(c.s.slice(c.i));
  if (!match) return Number.NaN;
  c.i += match[0].length;
  return Number(match[0].replaceAll("_", ""));
}

function canStartRegex(c: Cursor): boolean {
  let j = c.i - 1;
  while (j >= 0 && /\s/.test(c.s[j])) j--;
  if (j < 0) return true;
  const ch = c.s[j];
  if ("([{=,:;!?&|+-*%^~<>".includes(ch)) return true;
  if (!/[\w$]/.test(ch)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(c.s[k])) k--;
  const word = c.s.slice(k + 1, j + 1);
  return [
    "return",
    "typeof",
    "case",
    "throw",
    "void",
    "delete",
    "in",
    "of",
    "await",
    "yield",
    "do",
    "else",
    "new",
  ].includes(word);
}

function skipRegex(c: Cursor): void {
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      c.i += 2;
      continue;
    }
    if (ch === "[") {
      c.i++;
      if (c.s[c.i] === "^") c.i++;
      while (c.i < c.s.length && c.s[c.i] !== "]" && c.s[c.i] !== "\n") {
        if (c.s[c.i] === "\\") c.i += 2;
        else c.i++;
      }
      if (c.s[c.i] === "]") c.i++;
      continue;
    }
    if (ch === "/" || ch === "\n") {
      if (ch === "/") c.i++;
      break;
    }
    c.i++;
  }
  while (/[a-z]/i.test(c.s[c.i] ?? "")) c.i++;
}

function skipType(c: Cursor): void {
  skipTypePrimary(c);
  while (true) {
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) return;
    if (c.peek() !== "|" && c.peek() !== "&") return;
    c.i++;
    skipTypePrimary(c);
  }
}

function skipTypePrimary(c: Cursor): void {
  c.skipTrivia();
  if (c.s.startsWith("=>", c.i)) return;
  if (
    c.startsWithIdent("keyof") ||
    c.startsWithIdent("readonly") ||
    c.startsWithIdent("unique") ||
    c.startsWithIdent("infer")
  ) {
    c.ident();
    skipTypePrimary(c);
    return;
  }
  if (c.startsWithIdent("typeof")) {
    c.ident();
    if (c.startsWithIdent("import")) {
      c.ident();
      if (c.peek() === "(") skipBalanced(c, "(", ")");
    } else {
      c.ident();
      while (c.eat(".")) c.ident();
    }
    return;
  }
  if (c.peek() === "(") {
    skipBalanced(c, "(", ")");
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) {
      c.i += 2;
      skipType(c);
    }
    return;
  }
  if (c.peek() === "{") {
    skipBalanced(c, "{", "}");
    while (c.peek() === "[") {
      c.eat("[");
      c.eat("]");
    }
    return;
  }
  if (c.peek() === "'" || c.peek() === '"') {
    parseString(c);
    return;
  }
  if (c.peek() === "`") {
    skipTemplate(c);
    return;
  }
  if (/[A-Za-z_$]/.test(c.peek())) {
    c.ident();
    while (c.eat(".")) c.ident();
    if (c.peek() === "<") skipAngles(c);
    while (c.peek() === "[") {
      c.eat("[");
      c.eat("]");
    }
  }
}

function skipAngles(c: Cursor): void {
  if (c.peek() !== "<") return;
  c.i++;
  let depth = 1;
  while (!c.done && depth > 0) {
    c.skipTrivia();
    if (c.s.startsWith("=>", c.i)) {
      c.i += 2;
      continue;
    }
    const ch = c.s[c.i];
    if (ch === "<") {
      depth++;
      c.i++;
      continue;
    }
    if (ch === ">") {
      depth--;
      c.i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    if (ch === "{") {
      skipBalanced(c, "{", "}");
      continue;
    }
    if (ch === "(") {
      skipBalanced(c, "(", ")");
      continue;
    }
    if (ch === "[") {
      skipBalanced(c, "[", "]");
      continue;
    }
    c.i++;
  }
}

function skipBalanced(c: Cursor, open: string, close: string): void {
  if (c.peek() !== open) return;
  c.i++;
  let depth = 1;
  while (!c.done && depth > 0) {
    const ch = c.s[c.i];
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    if (ch === "/" && c.s[c.i + 1] === "/") {
      c.i += 2;
      while (c.i < c.s.length && c.s[c.i] !== "\n") c.i++;
      continue;
    }
    if (ch === "/" && c.s[c.i + 1] === "*") {
      c.i += 2;
      while (c.i < c.s.length && !(c.s[c.i] === "*" && c.s[c.i + 1] === "/")) c.i++;
      c.i += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) depth--;
    c.i++;
  }
}

function skipTemplate(c: Cursor): void {
  if (c.s[c.i] !== "`") return;
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === "\\") {
      c.i += 2;
      continue;
    }
    if (ch === "`") {
      c.i++;
      return;
    }
    if (ch === "$" && c.s[c.i + 1] === "{") {
      c.i += 2;
      let depth = 1;
      while (c.i < c.s.length && depth > 0) {
        const inner = c.s[c.i];
        if (inner === "'" || inner === '"') {
          parseString(c);
          continue;
        }
        if (inner === "`") {
          skipTemplate(c);
          continue;
        }
        if (inner === "{") depth++;
        else if (inner === "}") depth--;
        if (depth > 0) c.i++;
      }
      if (c.s[c.i] === "}") c.i++;
      continue;
    }
    c.i++;
  }
}

function skipLoose(c: Cursor): void {
  let depth = 0;
  while (!c.done) {
    c.skipTrivia();
    const ch = c.peek();
    if ((ch === ";" || ch === "}") && depth === 0) {
      if (ch === ";") c.i++;
      return;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      c.i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      c.i++;
      if (depth === 0 && ch === "}") return;
      continue;
    }
    if (ch === "'" || ch === '"') {
      parseString(c);
      continue;
    }
    if (ch === "`") {
      skipTemplate(c);
      continue;
    }
    c.i++;
  }
}
