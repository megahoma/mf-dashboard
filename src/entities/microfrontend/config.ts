import path from "node:path";
import type { Binding } from "@babel/traverse";
import type * as t from "@babel/types";
import { noLog, type LogContext } from "../../shared/logging.ts";
import { ConfigImports } from "./config-imports.ts";
import { parseProgram, type AstPath, type Program } from "./syntax.ts";

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

const UNKNOWN = Symbol("unknown");
const TAG = Symbol("static-value");
interface FunctionValue {
  [TAG]: "function";
  path: AstPath;
  frame: Map<Binding, Value>;
}
interface MissingTemplate {
  [TAG]: "missing-template";
  name: string | null;
}
type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | typeof UNKNOWN
  | Value[]
  | { [key: string]: Value }
  | FunctionValue
  | MissingTemplate;
type ObjectValue = { [key: string]: Value };
const PLUGINS = new Set([
  "pluginModuleFederation",
  "ModuleFederationPlugin",
  "createModuleFederationConfig",
  "federation",
]);
const CONTROLS = new Set([
  "IfStatement",
  "SwitchStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
]);
function object(value: Value): value is ObjectValue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, TAG)
  );
}
function string(value: Value): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
function primitive(value: Value): value is string | number | boolean | null | undefined {
  return (
    value !== UNKNOWN &&
    (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value))
  );
}
function flag(value: Value, fallback: boolean): boolean {
  if (value === UNKNOWN) return false;
  return typeof value === "boolean" ? value : value && typeof value === "object" ? true : fallback;
}

class StaticConfig {
  readonly imports: ConfigImports;
  readonly origins = new WeakMap<object, string>();
  readonly plugins = new Set<Value>();
  private readonly active = new Set<t.Node>();
  private configResult: { value: Value } | undefined;
  readonly parsed: Program;
  readonly env: Record<string, string>;
  readonly log: LogContext;
  constructor(
    parsed: Program,
    env: Record<string, string>,
    dependencies?: Set<string>,
    log: LogContext = noLog,
  ) {
    this.parsed = parsed;
    this.env = env;
    this.log = log;
    this.imports = new ConfigImports(parsed, dependencies, log);
  }
  private unknown(p: AstPath, reason = "unsupported-expression"): typeof UNKNOWN {
    this.log.event("trace", "config.helper.unresolved", {
      file: this.imports.fileOf(p),
      reason,
      line: p.node.loc?.start.line,
    });
    return UNKNOWN;
  }
  // Imported or unbound known API names only; a local function with the same name is a helper.
  api(p: AstPath, names: ReadonlySet<string>): boolean {
    if (p.isIdentifier() && !p.scope.getBinding(p.node.name)) return names.has(p.node.name);
    const reference = this.apiReference(p);
    if (!reference) return false;
    const { source, members } = reference;
    if (
      !/^@module-federation\//.test(source) &&
      !["@rsbuild/core", "@rspack/core", "webpack", "vite"].includes(source)
    )
      return false;
    if (!members.length) return names.has("federation") && /^@module-federation\//.test(source);
    return (
      names.has(members.at(-1)!) &&
      (members.length === 1 ||
        (members.length === 2 &&
          members[0] === "container" &&
          ["webpack", "@rspack/core"].includes(source)))
    );
  }
  // Recognize package references syntactically; never execute require from a config.
  private apiReference(p: AstPath, depth = 0): { source: string; members: string[] } | null {
    if (depth > 8) return null;
    if (
      p.isCallExpression() &&
      p.get("callee").isIdentifier({ name: "require" }) &&
      !p.scope.getBinding("require")
    ) {
      const args = p.get("arguments");
      return args.length === 1 && args[0].isStringLiteral()
        ? { source: args[0].node.value, members: [] }
        : null;
    }
    if (p.isMemberExpression()) {
      const key = p.get("property");
      const name =
        !p.node.computed && key.isIdentifier()
          ? key.node.name
          : key.isStringLiteral()
            ? key.node.value
            : null;
      const owner = this.apiReference(p.get("object"), depth + 1);
      return owner && name ? { ...owner, members: [...owner.members, name] } : null;
    }
    if (!p.isIdentifier()) return null;
    const binding = p.scope.getBinding(p.node.name);
    if (!binding)
      return ["webpack", "rspack"].includes(p.node.name)
        ? { source: p.node.name === "webpack" ? "webpack" : "@rspack/core", members: [] }
        : null;
    if (!binding.constant) return null;
    const declaration = binding.path;
    if (
      declaration.isImportSpecifier() ||
      declaration.isImportDefaultSpecifier() ||
      declaration.isImportNamespaceSpecifier()
    ) {
      const imported = declaration.isImportSpecifier() ? declaration.node.imported : null;
      return {
        source: (declaration.parent as t.ImportDeclaration).source.value,
        members: imported ? [imported.type === "Identifier" ? imported.name : imported.value] : [],
      };
    }
    if (!declaration.isVariableDeclarator()) return null;
    const reference = this.apiReference(declaration.get("init") as AstPath, depth + 1);
    const id = declaration.get("id");
    if (!reference || id.isIdentifier()) return reference;
    if (!id.isObjectPattern()) return null;
    const prop = id
      .get("properties")
      .find(
        (prop) =>
          prop.isObjectProperty() &&
          Object.values(prop.getBindingIdentifiers()).includes(binding.identifier),
      );
    if (!prop?.isObjectProperty()) return null;
    const key = prop.get("key");
    const name =
      !prop.node.computed && key.isIdentifier()
        ? key.node.name
        : key.isStringLiteral()
          ? key.node.value
          : null;
    return name ? { ...reference, members: [...reference.members, name] } : null;
  }
  evaluate(p: AstPath | null, frame = new Map<Binding, Value>(), depth = 0): Value {
    if (!p?.node) return undefined;
    if (depth > 64 || this.active.has(p.node)) return this.unknown(p, "evaluation-cycle-or-depth");
    this.active.add(p.node);
    try {
      return this.value(p, frame, depth + 1);
    } finally {
      this.active.delete(p.node);
    }
  }
  private value(p: AstPath, frame: Map<Binding, Value>, depth: number): Value {
    const ev = (child: AstPath | null): Value => this.evaluate(child, frame, depth);
    if (p.isStringLiteral() || p.isNumericLiteral() || p.isBooleanLiteral()) return p.node.value;
    if (p.isNullLiteral()) return null;
    if (
      p.isParenthesizedExpression() ||
      p.isTSAsExpression() ||
      p.isTSSatisfiesExpression() ||
      p.isTSNonNullExpression() ||
      p.isTSTypeAssertion()
    )
      return ev(p.get("expression") as AstPath);
    if (p.isIdentifier()) {
      const binding = p.scope.getBinding(p.node.name);
      if (!binding)
        return p.node.name === "undefined" ? undefined : this.unknown(p, "unbound-reference");
      if (!binding.constant) return this.unknown(p, "mutable-binding");
      // Apply the same write guard to locals and helper parameters.
      if (
        binding.referencePaths.some((reference) => {
          let parent: AstPath = reference;
          while (
            parent.parentPath?.isMemberExpression() ||
            parent.parentPath?.isOptionalMemberExpression()
          )
            parent = parent.parentPath;
          return (
            (parent.parentPath?.isAssignmentExpression() && parent.key === "left") ||
            parent.parentPath?.isUpdateExpression() ||
            (parent.parentPath?.isUnaryExpression({ operator: "delete" }) &&
              parent.key === "argument")
          );
        })
      )
        return this.unknown(p, "unsupported-write");
      if (frame.has(binding)) return frame.get(binding);
      const declaration = binding.path;
      if (declaration.isImportSpecifier() || declaration.isImportDefaultSpecifier()) {
        const target = this.imports.resolve(
          declaration,
          (declaration.parent as t.ImportDeclaration).source.value,
        );
        const imported = declaration.isImportDefaultSpecifier()
          ? "default"
          : declaration.node.imported.type === "Identifier"
            ? declaration.node.imported.name
            : declaration.node.imported.value;
        return target ? ev(this.imports.exported(target, imported)) : UNKNOWN;
      }
      if (declaration.isFunctionDeclaration()) return ev(declaration);
      if (declaration.isVariableDeclarator()) {
        let value = ev(declaration.get("init") as AstPath);
        const id = declaration.get("id");
        if (id.isObjectPattern()) {
          const prop = id
            .get("properties")
            .find(
              (prop) =>
                prop.isObjectProperty() &&
                Object.values(prop.getBindingIdentifiers()).some(
                  (identifier) => identifier === binding.identifier,
                ),
            );
          if (!prop?.isObjectProperty()) return UNKNOWN;
          const key = prop.node.computed
            ? ev(prop.get("key"))
            : prop.node.key.type === "Identifier"
              ? prop.node.key.name
              : prop.node.key.type === "StringLiteral"
                ? prop.node.key.value
                : UNKNOWN;
          value = object(value) && primitive(key) ? value[String(key)] : UNKNOWN;
          const target = prop.get("value");
          if (value === undefined && target.isAssignmentPattern()) value = ev(target.get("right"));
        }
        return value;
      }
      return this.unknown(p);
    }
    if (p.isObjectExpression()) {
      const result: ObjectValue = Object.create(null);
      for (const prop of p.get("properties")) {
        if (prop.isSpreadElement()) {
          const spread = ev(prop.get("argument"));
          if (!object(spread)) return this.unknown(prop, "unresolved-spread");
          Object.assign(result, spread);
        } else if (prop.isObjectProperty()) {
          const key = prop.node.computed
            ? ev(prop.get("key"))
            : prop.node.key.type === "Identifier"
              ? prop.node.key.name
              : "value" in prop.node.key
                ? prop.node.key.value
                : UNKNOWN;
          if (!primitive(key)) return this.unknown(prop, "unresolved-property-key");
          result[String(key)] = ev(prop.get("value"));
        } else if (
          prop.isObjectMethod() &&
          !prop.node.computed &&
          prop.node.key.type === "Identifier"
        ) {
          result[prop.node.key.name] = UNKNOWN;
        }
      }
      this.origins.set(result, this.imports.fileOf(p));
      return result;
    }
    if (p.isArrayExpression()) {
      const result: Value[] = [];
      for (const item of p.get("elements")) {
        if (item.isSpreadElement()) {
          const value = ev(item.get("argument"));
          if (!Array.isArray(value)) return this.unknown(item, "unknown-spread");
          result.push(...value);
        } else result.push(item.node ? ev(item as AstPath) : undefined);
      }
      return result;
    }
    if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
      const owner = p.get("object") as AstPath;
      const key = p.node.computed
        ? ev(p.get("property") as AstPath)
        : p.node.property.type === "Identifier"
          ? p.node.property.name
          : UNKNOWN;
      if (!primitive(key)) return UNKNOWN;
      if (
        (owner.matchesPattern("process.env") && !p.scope.getBinding("process")) ||
        owner.matchesPattern("import.meta.env")
      )
        return Object.hasOwn(this.env, String(key)) ? this.env[String(key)] : undefined;
      if (owner.isIdentifier()) {
        const binding = owner.scope.getBinding(owner.node.name);
        if (binding?.path.isImportNamespaceSpecifier()) {
          const target = this.imports.resolve(
            binding.path,
            (binding.path.parent as t.ImportDeclaration).source.value,
          );
          return target ? ev(this.imports.exported(target, String(key))) : UNKNOWN;
        }
      }
      const value = ev(owner);
      if (object(value) || Array.isArray(value))
        return Object.hasOwn(value, String(key)) ? (value as ObjectValue)[String(key)] : undefined;
      return UNKNOWN;
    }
    if (p.isTemplateLiteral()) {
      let text = p.node.quasis[0].value.cooked ?? "";
      let knownPrefix = text;
      let missing = false;
      for (const [index, expression] of p.get("expressions").entries()) {
        const value = ev(expression);
        if (!primitive(value) || value == null) missing = true;
        if (!missing) text += String(value);
        text += p.node.quasis[index + 1].value.cooked ?? "";
        if (!missing) knownPrefix = text;
      }
      return missing
        ? {
            [TAG]: "missing-template",
            name: knownPrefix.includes("@") ? knownPrefix.slice(0, knownPrefix.indexOf("@")) : null,
          }
        : text;
    }
    if (p.isBinaryExpression() || p.isLogicalExpression()) {
      const left = ev(p.get("left") as AstPath);
      if (left === UNKNOWN || !primitive(left)) return UNKNOWN;
      const op = p.node.operator;
      if (op === "??") return left == null ? ev(p.get("right") as AstPath) : left;
      if (op === "||") return left ? left : ev(p.get("right") as AstPath);
      if (op === "&&") return left ? ev(p.get("right") as AstPath) : left;
      const right = ev(p.get("right") as AstPath);
      if (!primitive(right)) return UNKNOWN;
      if (op === "+" && (typeof left === "string" || typeof right === "string"))
        return String(left) + String(right);
      if (typeof left === "number" && typeof right === "number") {
        if (op === "+") return left + right;
        if (op === "-") return left - right;
        if (op === "*") return left * right;
      }
      if (op === "===") return left === right;
      if (op === "!==") return left !== right;
      return UNKNOWN;
    }
    if (p.isUnaryExpression()) {
      const value = ev(p.get("argument"));
      if (!primitive(value)) return UNKNOWN;
      if (p.node.operator === "!") return !value;
      if (p.node.operator === "-" && typeof value === "number") return -value;
      if (p.node.operator === "+" && (typeof value === "number" || typeof value === "string"))
        return Number(value);
      return UNKNOWN;
    }
    if (p.isConditionalExpression()) {
      const condition = ev(p.get("test"));
      return primitive(condition) ? ev(p.get(condition ? "consequent" : "alternate")) : UNKNOWN;
    }
    if (p.isFunction()) return { [TAG]: "function", path: p, frame: new Map(frame) };
    if (p.isCallExpression() || p.isNewExpression()) {
      const callee = p.get("callee") as AstPath;
      const args = p.get("arguments") as AstPath[];
      if (this.api(callee, PLUGINS)) {
        const options = ev((args[0] as AstPath) ?? null);
        this.plugins.add(options);
        return options;
      }
      if (this.api(callee, new Set(["defineConfig"]))) {
        const config = ev((args[0] as AstPath) ?? null);
        return config && typeof config === "object" && TAG in config && config[TAG] === "function"
          ? this.call(config as FunctionValue, [], depth)
          : config;
      }
      if (
        callee.isIdentifier({ name: "require" }) &&
        !callee.scope.getBinding("require") &&
        args[0]?.isStringLiteral()
      ) {
        const target = this.imports.resolve(p, args[0].node.value);
        return target ? ev(this.imports.exported(target, "default")) : UNKNOWN;
      }
      const fn = ev(callee);
      if (!fn || typeof fn !== "object" || !(TAG in fn) || fn[TAG] !== "function")
        return this.unknown(p, "unsupported-call");
      return this.call(
        fn as FunctionValue,
        args.map((arg) => ev(arg as AstPath)),
        depth,
      );
    }
    return this.unknown(p);
  }
  private call(fn: FunctionValue, args: Value[], depth: number): Value {
    const p = fn.path;
    if (!p.isFunction() || p.node.async || p.node.generator)
      return this.unknown(p, "async-or-generator-helper");
    const frame = new Map(fn.frame);
    const bind = (param: AstPath, value: Value): void => {
      if (param.isAssignmentPattern()) {
        bind(
          param.get("left"),
          value === undefined ? this.evaluate(param.get("right"), frame, depth) : value,
        );
        return;
      }
      if (param.isIdentifier()) {
        const binding = p.scope.getBinding(param.node.name);
        if (binding) frame.set(binding, value);
        return;
      }
      if (param.isObjectPattern()) {
        for (const prop of param.get("properties")) {
          if (!prop.isObjectProperty() || prop.node.computed) continue;
          const key =
            prop.node.key.type === "Identifier"
              ? prop.node.key.name
              : prop.node.key.type === "StringLiteral"
                ? prop.node.key.value
                : "";
          bind(prop.get("value"), object(value) ? value[key] : UNKNOWN);
        }
      }
    };
    p.get("params").forEach((param, index) => bind(param, args[index]));
    const body = p.get("body");
    if (!body.isBlockStatement()) return this.evaluate(body, frame, depth);
    let conditional = false;
    body.traverse({
      Function(nested) {
        nested.skip();
      },
      ReturnStatement(returned) {
        if (
          returned.findParent((parent) =>
            parent === body
              ? false
              : CONTROLS.has(parent.node.type) && parent.getFunctionParent() === p,
          )
        )
          conditional = true;
      },
    });
    if (conditional) return this.unknown(p, "conditional-return");
    const returned = this.returned(body);
    return returned ? this.evaluate(returned.get("argument") as AstPath, frame, depth) : undefined;
  }
  private returned(block: AstPath): AstPath | null {
    if (!block.isBlockStatement()) return null;
    for (const statement of block.get("body")) {
      if (statement.isReturnStatement()) return statement;
      if (statement.isBlockStatement()) {
        const result = this.returned(statement);
        if (result) return result;
      }
    }
    return null;
  }
  config(): Value {
    if (this.configResult) return this.configResult.value;
    const value = this.evaluate(this.imports.exported(this.parsed, "default"));
    const result =
      value && typeof value === "object" && TAG in value && value[TAG] === "function"
        ? this.call(value as FunctionValue, [], 0)
        : value;
    this.configResult = { value: result };
    return result;
  }
  options(): ObjectValue | null {
    const config = this.config(); // Only values retained in the exported config participate.
    if (object(config) && Array.isArray(config.plugins)) {
      for (const plugin of config.plugins)
        if (this.plugins.has(plugin) && object(plugin)) return plugin;
      return null;
    }
    if (object(config) && this.plugins.has(config)) return config;
    if (this.plugins.size === 0) {
      for (const call of this.parsed.calls) {
        if (
          !(call.isCallExpression() || call.isNewExpression()) ||
          !this.api(call.get("callee") as AstPath, PLUGINS)
        )
          continue;
        if (call.getFunctionParent() || call.findParent((parent) => CONTROLS.has(parent.node.type)))
          continue;
        // Preserve standalone plugin declarations; skip decoys inside unrelated objects.
        if (this.parsed.exports.has("default") && !call.parentPath?.isExpressionStatement())
          continue;
        this.evaluate(call);
      }
    }
    for (const value of this.plugins.values()) if (object(value)) return value;
    const fallback = this.config();
    if (
      object(fallback) &&
      (path.basename(this.parsed.file).startsWith("module-federation.config.") ||
        ["name", "remotes", "exposes", "dts", "manifest", "filename"].some((key) =>
          Object.hasOwn(fallback, key),
        ))
    )
      return fallback;
    return null;
  }
}

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  const parsed = parseProgram(source, filePath);
  return parsed ? discoverProgram(parsed, source, filePath, env) : null;
}
export function discoverProgram(
  parsed: Program,
  source: string,
  filePath: string,
  env: Record<string, string>,
  dependencies?: Set<string>,
  log: LogContext = noLog,
): LocalApp | null {
  const evaluator = new StaticConfig(parsed, env, dependencies, log);
  const options = evaluator.options();
  if (!options) return null;
  const name = string(options.name);
  if (!name) return null;
  const config = evaluator.config();
  const server = object(config) && object(config.server) ? config.server : null;
  const devServer = object(config) && object(config.devServer) ? config.devServer : null;
  const dts = object(options.dts) ? options.dts : null;
  const generateTypes = dts ? flag(dts.generateTypes, true) : options.dts === true;
  const consumeTypes = dts ? flag(dts.consumeTypes, true) : options.dts === true;
  const generate = dts && object(dts.generateTypes) ? dts.generateTypes : null;
  const consume = dts && object(dts.consumeTypes) ? dts.consumeTypes : null;
  const manifest = object(options.manifest) ? options.manifest : null;
  let prefix = "";
  if (source.includes("import.meta.env.ASSET_PREFIX") && env.ASSET_PREFIX?.trim())
    prefix = env.ASSET_PREFIX.trim();
  else if (server) prefix = string(server.base) ?? "";
  const fileName = string(manifest?.fileName) ?? "mf-manifest.json";
  return {
    name,
    folder: path.dirname(filePath),
    configFile: evaluator.origins.get(options) ?? filePath,
    port: portValue(server?.port) ?? portValue(devServer?.port),
    manifest: flag(options.manifest, false),
    generateTypes,
    consumeTypes,
    typesFolder:
      (consumeTypes && string(consume?.typesFolder)) ||
      (generateTypes && string(generate?.typesFolder)) ||
      "@mf-types",
    tsconfig: (generateTypes && string(generate?.tsConfigPath)) || string(dts?.tsConfigPath),
    compilerInstance: generateTypes ? string(generate?.compilerInstance) : null,
    manifestPath: `/${prefix.replace(/^\/+|\/+$/g, "")}/${fileName.replace(/^\/+/, "")}`.replace(
      /\/{2,}/g,
      "/",
    ),
    remotes: object(options.remotes)
      ? Object.entries(options.remotes).map(([alias, value]) => readRemote(alias, value))
      : [],
  };
}
export function readPort(
  parsed: Program,
  env: Record<string, string>,
  dependencies?: Set<string>,
  log: LogContext = noLog,
): number | null {
  const config = new StaticConfig(parsed, env, dependencies, log).config();
  return object(config)
    ? (portValue(object(config.server) ? config.server.port : undefined) ??
        portValue(object(config.devServer) ? config.devServer.port : undefined))
    : null;
}
function portValue(value: Value): number | null {
  const port =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
function readRemote(alias: string, value: Value): LocalApp["remotes"][number] {
  if (object(value)) return readRemote(alias, value.external ?? value.entry);
  if (Array.isArray(value)) return readRemote(alias, value[0]);
  if (value && typeof value === "object" && TAG in value && value[TAG] === "missing-template")
    return { alias, name: (value as MissingTemplate).name || alias, url: null };
  if (typeof value !== "string") return { alias, name: alias, url: null };
  const at = value.indexOf("@");
  const name = at > 0 ? value.slice(0, at) : alias;
  const url = (at > 0 ? value.slice(at + 1) : value).trim();
  return { alias, name, url: url && !url.includes("${") ? url : null };
}
