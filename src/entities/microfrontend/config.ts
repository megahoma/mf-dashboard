import path from "node:path";
import { parseProgram, objectAst, prop, type Ast, type Program } from "./syntax.ts";
import { loadCallee } from "./config-imports.ts";

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

type Val =
  | { t: "miss" }
  | { t: "null" }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "obj"; v: Record<string, Val> };

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  return discoverProgram(parseProgram(source), source, filePath, env);
}

export function discoverProgram(
  parsed: Program,
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
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

function isFederationFile(filePath: string): boolean {
  return path.basename(filePath).startsWith("module-federation.config.");
}

function federationShape(obj: Ast): boolean {
  return ["name", "remotes", "exposes", "dts", "manifest", "filename"].some(
    (key) => prop(obj, key) !== undefined,
  );
}

export function readPort(
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
