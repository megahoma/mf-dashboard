import path from "node:path";
import type { Binding } from "@babel/traverse";
import type * as t from "@babel/types";
import { noLog, type LogContext } from "../../shared/logging.ts";
import { ConfigImports } from "./config-imports.ts";
import { hasMemberWrites, parseProgram, type AstPath, type Program } from "./syntax.ts";

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
  buildConfigFile?: string;
  generatedZipPath?: string | null;
  configDependencies?: readonly string[];
  hasExposes?: boolean;
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
  private evaluationCutoffs = 0;
  // A snapshot belongs to one helper invocation and one source position.
  private readonly objectSnapshots = new WeakMap<Map<Binding, Value>, Map<t.Node, ObjectValue>>();
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
    if (depth > 64 || this.active.has(p.node)) {
      this.evaluationCutoffs++;
      return this.unknown(p, "evaluation-cycle-or-depth");
    }
    this.active.add(p.node);
    try {
      return this.value(p, frame, depth + 1);
    } finally {
      this.active.delete(p.node);
    }
  }
  private exported(
    program: Program,
    name: string,
    frame = new Map<Binding, Value>(),
    depth = 0,
  ): Value {
    const exported = this.imports.exported(program, name);
    if (!exported || !("object" in exported)) return this.evaluate(exported, frame, depth);
    const value = this.evaluate(exported.object, frame, depth);
    return object(value) ? value[exported.imported] : UNKNOWN;
  }
  private localObject(
    binding: Binding,
    reference: AstPath,
    frame: Map<Binding, Value>,
    depth: number,
  ): Value {
    const declaration = binding.path;
    const owner = declaration.getFunctionParent();
    if (
      binding.kind !== "const" ||
      !declaration.isVariableDeclarator() ||
      !declaration.get("id").isIdentifier() ||
      !declaration.get("init").isObjectExpression() ||
      !owner ||
      reference.getFunctionParent() !== owner
    )
      return this.unknown(reference, "unsupported-write");
    let snapshots = this.objectSnapshots.get(frame);
    if (!snapshots) {
      snapshots = new Map();
      this.objectSnapshots.set(frame, snapshots);
    }
    const cached = snapshots.get(reference.node);
    if (cached) return cached;
    const writes: AstPath[] = [];
    for (const use of binding.referencePaths) {
      const member = use.parentPath;
      const write = member?.parentPath;
      if (
        member?.isMemberExpression() &&
        use.key === "object" &&
        write?.isAssignmentExpression({ operator: "=" }) &&
        member.key === "left" &&
        write.parentPath.isExpressionStatement()
      ) {
        if (
          write.getFunctionParent() !== owner ||
          (write.node.start ?? 0) < (declaration.node.end ?? 0)
        )
          return this.unknown(write, "unsupported-write");
        writes.push(write);
      } else if (
        !(member?.isMemberExpression() && use.key === "object") &&
        !member?.isReturnStatement() &&
        !member?.isSpreadElement() &&
        !(
          member?.isObjectProperty() &&
          use.key === "value" &&
          member.parentPath?.parentPath?.isReturnStatement()
        )
      )
        return this.unknown(use, "unsupported-object-reference");
      let access: AstPath = use;
      while (access.parentPath) {
        const parent = access.parentPath;
        if (
          ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
            access.key === "object") ||
          ((parent.isParenthesizedExpression() ||
            parent.isTSAsExpression() ||
            parent.isTSSatisfiesExpression() ||
            parent.isTSNonNullExpression() ||
            parent.isTSTypeAssertion() ||
            parent.isTSInstantiationExpression()) &&
            access.key === "expression")
        )
          access = parent;
        else break;
      }
      if (
        (access.key === "callee" &&
          (access.parentPath?.isCallExpression() ||
            access.parentPath?.isOptionalCallExpression() ||
            access.parentPath?.isNewExpression())) ||
        (access.key === "tag" && access.parentPath?.isTaggedTemplateExpression())
      )
        return this.unknown(use, "unsupported-object-reference");
    }
    // Only direct local writes are interpreted; aliases and nested mutations keep their guard.
    if (hasMemberWrites(binding, new Set(writes.map((write) => write.node))))
      return this.unknown(reference, "unsupported-write");
    const cutoffs = this.evaluationCutoffs;
    const result = this.evaluate(declaration.get("init") as AstPath, frame, depth);
    if (!object(result)) return UNKNOWN;
    writes.sort((left, right) => (left.node.start ?? 0) - (right.node.start ?? 0));
    for (const write of writes) {
      // A key or RHS reads the state before its own assignment completes.
      if ((write.node.end ?? 0) >= (reference.node.start ?? 0)) continue;
      const branches: { test: AstPath; consequent: boolean }[] = [];
      for (
        let child = write;
        child.parentPath && child.parentPath !== owner;
        child = child.parentPath
      ) {
        const parent = child.parentPath;
        if (parent.isIfStatement()) {
          branches.unshift({ test: parent.get("test"), consequent: child.key === "consequent" });
        } else if (!parent.isBlockStatement() && !parent.isExpressionStatement())
          return this.unknown(write, "unsupported-write-control");
      }
      let selected = true;
      for (const branch of branches) {
        const condition = this.evaluate(branch.test, frame, depth);
        if (!primitive(condition)) return this.unknown(branch.test, "unresolved-write-condition");
        if (Boolean(condition) !== branch.consequent) {
          selected = false;
          break;
        }
      }
      if (!selected || !write.isAssignmentExpression()) continue;
      const member = write.get("left");
      if (!member.isMemberExpression()) return UNKNOWN;
      const key = member.node.computed
        ? this.evaluate(member.get("property") as AstPath, frame, depth)
        : member.node.property.type === "Identifier"
          ? member.node.property.name
          : UNKNOWN;
      if (!primitive(key)) return this.unknown(member, "unresolved-property-key");
      result[String(key)] = this.evaluate(write.get("right"), frame, depth);
    }
    // Cutoff values depend on the caller's depth/stack, so they cannot be reused.
    if (this.evaluationCutoffs === cutoffs) snapshots.set(reference.node, result);
    return result;
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
      if (!binding) {
        if (p.node.name === "__dirname") return path.dirname(this.imports.fileOf(p));
        return p.node.name === "undefined" ? undefined : this.unknown(p, "unbound-reference");
      }
      if (!binding.constant) return this.unknown(p, "mutable-binding");
      // Apply the same write guard to locals and helper parameters.
      if (hasMemberWrites(binding)) return this.localObject(binding, p, frame, depth);
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
        return target ? this.exported(target, imported, frame, depth) : UNKNOWN;
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
        } else if (prop.isObjectProperty() || prop.isObjectMethod()) {
          const key = prop.node.computed
            ? ev(prop.get("key") as AstPath)
            : prop.node.key.type === "Identifier"
              ? prop.node.key.name
              : "value" in prop.node.key
                ? prop.node.key.value
                : UNKNOWN;
          if (!primitive(key)) return this.unknown(prop, "unresolved-property-key");
          result[String(key)] = prop.isObjectProperty() ? ev(prop.get("value")) : UNKNOWN;
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
          if (!binding.constant || hasMemberWrites(binding))
            return this.unknown(owner, "unsupported-write");
          const target = this.imports.resolve(
            binding.path,
            (binding.path.parent as t.ImportDeclaration).source.value,
          );
          return target ? this.exported(target, String(key), frame, depth) : UNKNOWN;
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
      const reference = this.apiReference(callee);
      const method = reference?.members.length === 1 ? reference.members[0] : undefined;
      if (
        p.isCallExpression() &&
        (reference?.source === "node:path" || reference?.source === "path") &&
        (method === "join" || method === "resolve")
      ) {
        const parts = args.map(ev);
        if (parts.every((part) => typeof part === "string")) {
          if (method === "join") return path.join(...parts);
          if (parts.some((part) => path.isAbsolute(part))) return path.resolve(...parts);
        }
        return this.unknown(p, "unresolved-output-path");
      }
      if (
        callee.isIdentifier({ name: "require" }) &&
        !callee.scope.getBinding("require") &&
        args[0]?.isStringLiteral()
      ) {
        const target = this.imports.resolve(p, args[0].node.value);
        return target ? this.exported(target, "default", frame, depth) : UNKNOWN;
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
    const value = this.exported(this.parsed, "default");
    const result =
      value && typeof value === "object" && TAG in value && value[TAG] === "function"
        ? this.call(value as FunctionValue, [], 0)
        : value;
    this.configResult = { value: result };
    return result;
  }
  options(): ObjectValue | null {
    const config = this.config(); // Only values retained in the exported config participate.
    if (object(config) && this.plugins.has(config)) return config;
    if (object(config) && Object.hasOwn(config, "plugins")) {
      if (Array.isArray(config.plugins))
        for (const plugin of config.plugins)
          if (this.plugins.has(plugin) && object(plugin)) return plugin;
      return null;
    }
    if (this.parsed.exports.has("default") && !object(config)) return null;
    for (const call of this.parsed.calls) {
      if (
        !(call.isCallExpression() || call.isNewExpression()) ||
        !call.parentPath?.isExpressionStatement() ||
        !this.api(call.get("callee") as AstPath, PLUGINS) ||
        call.getFunctionParent() ||
        call.findParent((parent) => CONTROLS.has(parent.node.type))
      )
        continue;
      const value = this.evaluate(call);
      if (object(value)) return value;
    }
    if (
      object(config) &&
      (path.basename(this.parsed.file).startsWith("module-federation.config.") ||
        ["name", "remotes", "exposes", "dts", "manifest", "filename"].some((key) =>
          Object.hasOwn(config, key),
        ))
    )
      return config;
    return null;
  }
}

export function discoverSource(
  source: string,
  filePath: string,
  env: Record<string, string>,
): LocalApp | null {
  const parsed = parseProgram(source, filePath);
  return parsed ? readConfigCandidate(parsed, source, filePath, env).app : null;
}

interface ConfigCandidate {
  app: LocalApp | null;
  port: number | null;
  outputDir: string | null;
  bundlerZipName?: string;
}

export function readConfigCandidate(
  parsed: Program,
  source: string,
  filePath: string,
  env: Record<string, string>,
  dependencies?: Set<string>,
  log: LogContext = noLog,
): ConfigCandidate {
  const evaluator = new StaticConfig(parsed, env, dependencies, log);
  const options = evaluator.options();
  const config = evaluator.config();
  const server = object(config) && object(config.server) ? config.server : null;
  const devServer = object(config) && object(config.devServer) ? config.devServer : null;
  const port = portValue(server?.port) ?? portValue(devServer?.port);
  const outputDir = buildOutputDir(config);
  const name = options && string(options.name);
  if (!options || !name) return { app: null, port, outputDir };
  const dts = object(options.dts) ? options.dts : null;
  const generateTypes = dts ? flag(dts.generateTypes, true) : options.dts === true;
  const consumeTypes = dts ? flag(dts.consumeTypes, true) : options.dts === true;
  const generate = dts && object(dts.generateTypes) ? dts.generateTypes : null;
  const consume = dts && object(dts.consumeTypes) ? dts.consumeTypes : null;
  const generatedFolder =
    generate?.typesFolder === undefined ? "@mf-types" : string(generate.typesFolder);
  const zipName = generatedFolder ? `${generatedFolder}.zip` : null;
  const dtsOutput = generate?.outputDir;
  const zipOutput = dtsOutput === undefined ? outputDir : string(dtsOutput);
  const exposes = options.exposes;
  const manifest = object(options.manifest) ? options.manifest : null;
  let prefix = "";
  if (source.includes("import.meta.env.ASSET_PREFIX") && env.ASSET_PREFIX?.trim())
    prefix = env.ASSET_PREFIX.trim();
  else if (server) prefix = string(server.base) ?? "";
  const fileName = string(manifest?.fileName) ?? "mf-manifest.json";
  const app: LocalApp = {
    name,
    folder: path.dirname(filePath),
    configFile: evaluator.origins.get(options) ?? filePath,
    port,
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
    ...(generateTypes && {
      buildConfigFile: filePath,
      generatedZipPath:
        zipName && zipOutput ? path.resolve(path.dirname(filePath), zipOutput, zipName) : null,
      hasExposes:
        exposes === UNKNOWN ||
        (object(exposes) && Object.keys(exposes).length > 0) ||
        (Array.isArray(exposes) && exposes.length > 0),
    }),
  };
  return {
    app,
    port,
    outputDir,
    bundlerZipName: generateTypes && dtsOutput === undefined && zipName ? zipName : undefined,
  };
}

function buildOutputDir(config: Value): string | null {
  if (!object(config)) return null;
  const { output, build } = config;
  if (output !== undefined && !object(output)) return null;
  if (build !== undefined && !object(build)) return null;
  const distPath = output?.distPath;
  const directory = output?.path ?? (object(distPath) ? distPath.root : distPath) ?? build?.outDir;
  return directory === undefined ? "dist" : string(directory);
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
