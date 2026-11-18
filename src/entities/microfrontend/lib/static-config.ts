import path from "node:path";
import type { Binding } from "@babel/traverse";
import type * as t from "@babel/types";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_ENV_MODE } from "../../../shared/config/project.ts";
import { sha256 } from "../../../shared/lib/fingerprint.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import {
  CONTROLS,
  FEDERATION_OPTION_KEYS,
  MAX_EVALUATED_STRING_LENGTH,
  MAX_EVALUATED_STRING_WORK,
  MAX_EVALUATION_DEPTH,
  MAX_EVALUATION_STEPS,
  MAX_SPREAD_ITEMS,
  NO_RETURN,
  OPTIONAL_MISS,
  PLUGINS,
  TAG,
  UNKNOWN,
} from "../config/config.ts";
import type {
  ConfigBundler,
  ConfigContext,
  ConfigOrigin,
  FederationOwnership,
  FunctionValue,
  ObjectValue,
  Value,
} from "../models/config.ts";
import type { ExpressionContext } from "../models/static-expression.ts";
import type { AstPath, Program } from "../models/syntax.ts";
import { isConfigApi } from "./config-api.ts";
import type { ConfigImports } from "./config-imports.ts";
import { evaluateExpression } from "./static-expression.ts";
import { object, primitive, string } from "./static-values.ts";
import { hasMemberWrites } from "./syntax.ts";

export class StaticConfig {
  readonly imports: ConfigImports;
  readonly origins = new WeakMap<object, string>();
  private readonly federationNameOrigins = new WeakMap<object, string>();
  private readonly federationNameSources = new WeakMap<object, ReadonlySet<string>>();
  private readonly callSites = new WeakMap<Map<Binding, Value>, string>();
  readonly plugins = new Map<Value, string | undefined>();
  private readonly active = new Set<t.Node>();
  private remainingSteps = MAX_EVALUATION_STEPS;
  private remainingSpreadItems = MAX_SPREAD_ITEMS;
  private remainingStringWork = MAX_EVALUATED_STRING_WORK;
  private evaluationCutoffs = 0;
  // A snapshot belongs to one helper invocation and one source position.
  private readonly objectSnapshots = new WeakMap<Map<Binding, Value>, Map<t.Node, ObjectValue>>();
  private readonly configOrigins = new WeakMap<object, ConfigOrigin>();
  private configResult: { value: Value; origin?: ConfigOrigin } | undefined;
  private readUnresolvedEnv = false;
  private readonly expressions: ExpressionContext;
  readonly parsed: Program;
  readonly env: Record<string, string>;
  readonly log: LogContext;
  private readonly context: ConfigContext;
  private readonly factoryFrames = new WeakSet<Map<Binding, Value>>();
  constructor(
    imports: ConfigImports,
    env: Record<string, string>,
    log: LogContext,
    context: ConfigContext = {},
    missingEnv?: typeof UNKNOWN,
  ) {
    this.parsed = imports.entry;
    this.env = env;
    this.context = context;
    this.log = log;
    this.imports = imports;
    this.expressions = {
      imports,
      configOrigins: this.configOrigins,
      origins: this.origins,
      federationNameOrigins: this.federationNameOrigins,
      federationNameSources: this.federationNameSources,
      plugins: this.plugins,
      evaluate: (p, frame, depth, inChain) => this.evaluate(p, frame, depth, inChain),
      exported: (program, name, frame, depth) => this.exported(program, name, frame, depth),
      localObject: (binding, p, frame, depth) => this.localObject(binding, p, frame, depth),
      call: (fn, args, depth, site, frame) =>
        this.call(fn, args, depth, false, this.constructionSite(site, frame)),
      constructionSite: (site, frame) => this.constructionSite(site, frame),
      unknown: (p, reason) => this.unknown(p, reason),
      appendArraySpread: (target, value, p) => this.appendArraySpread(target, value, p),
      reserveString: (length, site) => {
        if (length > MAX_EVALUATED_STRING_LENGTH || length > this.remainingStringWork) {
          this.evaluationCutoffs++;
          this.unknown(site, "string-evaluation-budget");
          return false;
        }
        this.remainingStringWork -= length;
        return true;
      },
      readEnv: (name, fromProcess) => {
        const environment = fromProcess ? (context.processEnv ?? env) : env;
        if (Object.hasOwn(environment, name)) return environment[name];
        this.readUnresolvedEnv = true;
        return missingEnv;
      },
    };
  }
  get importedBundler(): ConfigBundler | undefined {
    const origin = this.configResult?.origin;
    return origin?.direct ? origin.bundler : undefined;
  }
  get bundler(): string | undefined {
    return this.bundlerFor(this.configResult?.origin);
  }
  private bundlerFor(origin: ConfigOrigin | undefined): string | undefined {
    if (this.context.bundler === "rslib") return "rslib";
    if (this.context.preferImportedBundler && origin?.direct) return origin.bundler;
    return this.context.bundler ?? origin?.bundler;
  }
  private unknown(p: AstPath, reason = "unsupported-expression"): typeof UNKNOWN {
    this.log.event("trace", "config.helper.unresolved", {
      file: this.imports.fileOf(p),
      reason,
      line: p.node.loc?.start.line,
    });
    return UNKNOWN;
  }
  private appendArraySpread(target: Value[], value: Value, site: AstPath): boolean {
    if (!Array.isArray(value)) {
      this.unknown(site, "unknown-spread");
      return false;
    }
    // One AST node can copy a whole imported array, including arrays built by earlier spreads.
    if (value.length > this.remainingSpreadItems) {
      this.evaluationCutoffs++;
      this.unknown(site, "array-spread-budget");
      return false;
    }
    this.remainingSpreadItems -= value.length;
    for (const element of value) target.push(element);
    return true;
  }
  evaluate(
    p: AstPath | null,
    frame = new Map<Binding, Value>(),
    depth = 0,
    inChain = false,
  ): Value {
    if (!p?.node) return undefined;
    if (this.remainingSteps === 0) {
      this.remainingSteps--;
      this.evaluationCutoffs++;
      return this.unknown(p, "evaluation-budget");
    }
    if (this.remainingSteps < 0) return UNKNOWN;
    this.remainingSteps--;
    if (depth > MAX_EVALUATION_DEPTH || this.active.has(p.node)) {
      this.evaluationCutoffs++;
      return this.unknown(p, "evaluation-cycle-or-depth");
    }
    this.active.add(p.node);
    try {
      const value = evaluateExpression(this.expressions, p, frame, depth + 1);
      return value === OPTIONAL_MISS && !inChain ? undefined : value;
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
    if (!exported) return undefined;
    const { value, files } = exported;
    let result: Value;
    if ("object" in value) {
      const container = this.evaluate(value.object, frame, depth);
      result = object(container) ? container[value.imported] : UNKNOWN;
    } else {
      result = this.evaluate(value, frame, depth);
    }
    if (object(result) && Object.hasOwn(result, "name")) {
      const previous = this.federationNameSources.get(result);
      if (!previous || files.some((file) => !previous.has(file))) {
        this.federationNameSources.set(result, new Set([...(previous ?? []), ...files]));
      }
    }
    return result;
  }

  federationOwnership(options: ObjectValue | null): FederationOwnership | undefined {
    if (!options || !this.plugins.has(options)) return;
    const sources = this.federationNameSources.get(options);
    const name = string(options.name);
    const origin = this.federationNameOrigin(options);
    if (!sources || !name || !origin) return;
    const files = this.imports.federationFiles(sources);
    if (files.length) return { name, origin, files };
  }
  federationNameOrigin(options: ObjectValue): string | undefined {
    return this.federationNameOrigins.get(options);
  }
  private constructionSite(site: AstPath, frame: Map<Binding, Value>): string | undefined {
    if (!this.context.trackRslibOwnership) return;
    const position = this.imports.sourcePosition(site);
    if (!position) return;
    // A module-level initializer keeps its identity when read from a config factory.
    const invocation = site.getFunctionParent() && this.callSites.get(frame);
    return invocation ? `${position}\0${invocation}` : position;
  }
  private localObject(
    binding: Binding,
    reference: AstPath,
    frame: Map<Binding, Value>,
    depth: number,
  ): Value {
    const declaration = binding.path;
    const owner = declaration.getFunctionParent() ?? declaration.findParent((p) => p.isProgram());
    const withinOwner = (p: AstPath) =>
      (p.getFunctionParent() ?? p.findParent((parent) => parent.isProgram()))?.node === owner?.node;
    const factory = reference.getFunctionParent();
    const captured = owner?.isProgram() === true && !!factory && this.factoryFrames.has(frame);
    if (
      binding.kind !== "const" ||
      !declaration.isVariableDeclarator() ||
      !declaration.get("id").isIdentifier() ||
      !declaration.get("init").isObjectExpression() ||
      !owner ||
      (!withinOwner(reference) && !captured)
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
        if (!withinOwner(write) || (write.node.start ?? 0) < (declaration.node.end ?? 0))
          return this.unknown(write, "unsupported-write");
        writes.push(write);
      } else if (
        !(member?.isMemberExpression() && use.key === "object") &&
        !member?.isReturnStatement() &&
        !member?.isSpreadElement() &&
        !(
          member?.isObjectProperty() &&
          use.key === "value" &&
          (this.isOptionsSink(member.parentPath?.parentPath) ||
            (captured && member.parentPath?.parentPath?.node === factory?.node))
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
    const returnsObject = reference
      .findParent((parent) => parent.isReturnStatement() || parent.isFunction())
      ?.isReturnStatement();
    for (const write of writes) {
      // A key or RHS reads the state before its own assignment completes.
      if (!captured && (write.node.end ?? 0) >= (reference.node.start ?? 0)) {
        if (!returnsObject && reference.parentPath?.isObjectProperty() && reference.key === "value")
          return this.unknown(write, "write-after-options");
        continue;
      }
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
      const name = String(key);
      result[name] = this.evaluate(write.get("right"), frame, depth);
      if (name === "name") {
        const position = this.constructionSite(write, frame);
        if (position) this.federationNameOrigins.set(result, position);
        else this.federationNameOrigins.delete(result);
        this.federationNameSources.delete(result);
      }
    }
    // Cutoff values depend on the caller's depth/stack, so they cannot be reused.
    if (this.evaluationCutoffs === cutoffs) snapshots.set(reference.node, result);
    return result;
  }
  private isOptionsSink(p: AstPath | null | undefined): boolean {
    return (
      !!p &&
      (p.isReturnStatement() ||
        p.isExportDefaultDeclaration() ||
        ((p.isCallExpression() || p.isNewExpression()) &&
          isConfigApi(p.get("callee") as AstPath, PLUGINS)))
    );
  }
  private call(
    fn: FunctionValue,
    args: Value[],
    depth: number,
    factory = false,
    site?: string,
  ): Value {
    const p = fn.path;
    if (!p.isFunction() || p.node.async || p.node.generator)
      return this.unknown(p, "async-or-generator-helper");
    const frame = new Map(fn.frame);
    if (factory) this.factoryFrames.add(frame);
    const origin =
      site ?? (factory && this.context.trackRslibOwnership && this.imports.sourcePosition(p));
    // A digest keeps the identity of nested invocations bounded.
    if (origin) this.callSites.set(frame, sha256(origin));
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
      if (param.isArrayPattern())
        param.get("elements").forEach((item, index) => {
          if (item.node) bind(item as AstPath, Array.isArray(value) ? value[index] : UNKNOWN);
        });
    };
    p.get("params").forEach((param, index) => bind(param, args[index]));
    const body = p.get("body");
    if (!body.isBlockStatement()) return this.evaluate(body, frame, depth);
    const controls = new Set<t.Node>();
    body.traverse({
      Function(nested) {
        nested.skip();
      },
      "ReturnStatement|ThrowStatement"(returned) {
        for (
          let parent: AstPath | null = returned.parentPath;
          parent && parent.node !== body.node;
          parent = parent.parentPath
        )
          controls.add(parent.node);
      },
    });
    const returned = this.returned(body, controls, frame, depth);
    return returned === NO_RETURN ? undefined : returned;
  }
  private returned(
    statement: AstPath | null,
    controls: ReadonlySet<t.Node>,
    frame: Map<Binding, Value>,
    depth: number,
  ): Value | typeof NO_RETURN {
    if (!statement?.node) return NO_RETURN;
    if (depth > MAX_EVALUATION_DEPTH) return this.unknown(statement, "conditional-return");
    if (statement.isReturnStatement())
      return this.evaluate(statement.get("argument") as AstPath, frame, depth);
    if (statement.isBlockStatement()) {
      for (const child of statement.get("body")) {
        const value = this.returned(child, controls, frame, depth + 1);
        if (value !== NO_RETURN) return value;
      }
      return NO_RETURN;
    }
    if (statement.isThrowStatement()) return this.unknown(statement, "conditional-return");
    if (!controls.has(statement.node)) return NO_RETURN;
    if (statement.isIfStatement()) {
      const condition = this.evaluate(statement.get("test"), frame, depth);
      if (!primitive(condition)) return this.unknown(statement, "conditional-return");
      return this.returned(
        statement.get(condition ? "consequent" : "alternate") as AstPath,
        controls,
        frame,
        depth + 1,
      );
    }
    if (statement.isSwitchStatement()) {
      const selector = this.evaluate(statement.get("discriminant"), frame, depth);
      if (!primitive(selector)) return this.unknown(statement, "conditional-return");
      const cases = statement.get("cases");
      let start = -1;
      let fallback = -1;
      for (const [index, branch] of cases.entries()) {
        const test = branch.get("test");
        if (!test.node) {
          fallback = index;
          continue;
        }
        const value = this.evaluate(test as AstPath, frame, depth);
        if (!primitive(value)) return this.unknown(statement, "conditional-return");
        if (selector === value) {
          start = index;
          break;
        }
      }
      const selected = start === -1 ? fallback : start;
      if (selected === -1) return NO_RETURN;
      for (const branch of cases.slice(selected)) {
        for (const child of branch.get("consequent")) {
          if (child.isReturnStatement())
            return this.evaluate(child.get("argument") as AstPath, frame, depth);
          if (child.isBreakStatement() && !child.node.label) return NO_RETURN;
          if (!child.isEmptyStatement()) return this.unknown(child, "conditional-return");
        }
      }
      return NO_RETURN;
    }
    return this.unknown(statement, "conditional-return");
  }
  config(): Value {
    if (this.configResult) return this.configResult.value;
    const value = this.exported(this.parsed, "default");
    const origin = value && typeof value === "object" ? this.configOrigins.get(value) : undefined;
    // defineConfig returns its argument. Only an exported factory gets the bundler's arguments.
    const result =
      value && typeof value === "object" && TAG in value && value[TAG] === "function"
        ? this.call(value, this.factoryArgs(this.bundlerFor(origin)), 0, true)
        : value;
    this.configResult = {
      value: result,
      origin: origin ?? (object(result) ? this.configOrigins.get(result) : undefined),
    };
    return result;
  }
  private factoryArgs(bundler: string | undefined): Value[] {
    const { mode = DEFAULT_ENV_MODE, command } = this.context;
    if (bundler === "vite")
      return [
        {
          command: command === "build" ? "build" : "serve",
          mode,
          isPreview: command === "preview",
        },
      ];
    if (bundler === "rsbuild")
      return [
        {
          command: command ?? "dev",
          env: this.env.NODE_ENV ?? (command ? "production" : DEFAULT_ENV_MODE),
          envMode: mode,
        },
      ];
    if (bundler === "rslib")
      return [
        {
          command: "mf-dev",
          env: this.context.processEnv?.NODE_ENV ?? DEFAULT_ENV_MODE,
          envMode: mode,
        },
      ];
    return [];
  }
  configForDevRoutes(): Value {
    const config = this.config();
    if (!this.readUnresolvedEnv) return config;
    // Rsbuild or the shell may supply variables absent from discovery's env files.
    return new StaticConfig(this.imports, this.env, noLog, this.context, UNKNOWN).config();
  }
  options(config = this.config()): ObjectValue | null {
    if (object(config) && this.plugins.has(config)) return config;
    if (object(config) && Object.hasOwn(config, "plugins")) {
      return Array.isArray(config.plugins) ? this.findPlugin(config.plugins) : null;
    }
    if (this.parsed.exports.has("default") && !object(config)) return null;
    for (const call of this.parsed.calls) {
      if (
        !(call.isCallExpression() || call.isNewExpression()) ||
        !call.parentPath?.isExpressionStatement() ||
        !isConfigApi(call.get("callee") as AstPath, PLUGINS) ||
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
        FEDERATION_OPTION_KEYS.some((key) => Object.hasOwn(config, key)))
    )
      return config;
    return null;
  }

  private findPlugin(plugins: Value[], visited = new Set<Value[]>()): ObjectValue | null {
    if (visited.has(plugins)) return null;
    visited.add(plugins);
    for (const plugin of plugins) {
      if (this.plugins.has(plugin) && object(plugin)) return plugin;
      if (this.bundler === "rslib" && Array.isArray(plugin)) {
        const found = this.findPlugin(plugin, visited);
        if (found) return found;
      }
    }
    return null;
  }
}
