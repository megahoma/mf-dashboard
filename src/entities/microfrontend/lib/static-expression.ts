import path from "node:path";
import type { Binding } from "@babel/traverse";
import type * as t from "@babel/types";
import { parse as parseEnv } from "dotenv";
import { CONFIG_FACTORIES, OPTIONAL_MISS, PLUGINS, TAG, UNKNOWN } from "../config/config.ts";
import type { ObjectValue, Value } from "../models/config.ts";
import type { ExpressionContext } from "../models/static-expression.ts";
import type { AstPath } from "../models/syntax.ts";
import { apiReference, isConfigApi } from "./config-api.ts";
import { object, primitive, remoteNameSeparator } from "./static-values.ts";
import { hasMemberWrites } from "./syntax.ts";

export function evaluateExpression(
  context: ExpressionContext,
  p: AstPath,
  frame: Map<Binding, Value>,
  depth: number,
): Value {
  const ev = (child: AstPath | null): Value => context.evaluate(child, frame, depth);
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
      if (p.node.name === "__dirname") return path.dirname(context.imports.fileOf(p));
      return p.node.name === "undefined" ? undefined : context.unknown(p, "unbound-reference");
    }
    if (!binding.constant) return context.unknown(p, "mutable-binding");
    // Apply the same write guard to locals and helper parameters.
    if (hasMemberWrites(binding)) return context.localObject(binding, p, frame, depth);
    if (frame.has(binding)) return frame.get(binding);
    const declaration = binding.path;
    if (declaration.isImportSpecifier() || declaration.isImportDefaultSpecifier()) {
      const source = (declaration.parent as t.ImportDeclaration).source.value;
      if (source.endsWith(".json")) {
        if (!declaration.isImportDefaultSpecifier()) return UNKNOWN;
        const value = context.imports.readJson(declaration, source);
        return value === undefined ? UNKNOWN : value;
      }
      const target = context.imports.resolve(declaration, source);
      const imported = declaration.isImportDefaultSpecifier()
        ? "default"
        : declaration.node.imported.type === "Identifier"
          ? declaration.node.imported.name
          : declaration.node.imported.value;
      return target ? context.exported(target, imported, frame, depth) : UNKNOWN;
    }
    if (declaration.isFunctionDeclaration()) return ev(declaration);
    if (declaration.isVariableDeclarator()) {
      let value = ev(declaration.get("init") as AstPath);
      const id = declaration.get("id");
      if (id.isArrayPattern()) {
        if (!Array.isArray(value)) return UNKNOWN;
        const index = id.get("elements").findIndex((item) => {
          const target = item.isAssignmentPattern() ? item.get("left") : item;
          return target.node === binding.identifier;
        });
        if (index < 0) return UNKNOWN;
        const item = id.get("elements")[index];
        return value[index] === undefined && item.isAssignmentPattern()
          ? ev(item.get("right"))
          : value[index];
      }
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
    return context.unknown(p);
  }
  if (p.isObjectExpression()) {
    const result: ObjectValue = Object.create(null);
    for (const prop of p.get("properties")) {
      if (prop.isSpreadElement()) {
        const spread = ev(prop.get("argument"));
        if (!object(spread)) return context.unknown(prop, "unresolved-spread");
        Object.assign(result, spread);
        const origin = context.configOrigins.get(spread);
        if (origin !== undefined) {
          const previous = context.configOrigins.get(result);
          // Shared config fragments are a fallback. Conflicting origins are inconclusive.
          context.configOrigins.set(
            result,
            origin && (previous === undefined || previous?.bundler === origin.bundler)
              ? { bundler: origin.bundler, direct: false }
              : null,
          );
        }
      } else if (prop.isObjectProperty() || prop.isObjectMethod()) {
        const key = prop.node.computed
          ? ev(prop.get("key") as AstPath)
          : prop.node.key.type === "Identifier"
            ? prop.node.key.name
            : "value" in prop.node.key
              ? prop.node.key.value
              : UNKNOWN;
        if (!primitive(key)) return context.unknown(prop, "unresolved-property-key");
        result[String(key)] = prop.isObjectProperty() ? ev(prop.get("value")) : UNKNOWN;
      }
    }
    context.origins.set(result, context.imports.fileOf(p));
    return result;
  }
  if (p.isArrayExpression()) {
    const result: Value[] = [];
    for (const item of p.get("elements")) {
      if (item.isSpreadElement()) {
        if (!context.appendArraySpread(result, ev(item.get("argument")), item)) return UNKNOWN;
      } else result.push(item.node ? ev(item as AstPath) : undefined);
    }
    return result;
  }
  if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
    const owner = p.get("object") as AstPath;
    const optional = p.isOptionalMemberExpression();
    const chained = optional ? context.evaluate(owner, frame, depth, true) : undefined;
    if (chained === OPTIONAL_MISS || (optional && p.node.optional && chained == null))
      return OPTIONAL_MISS;
    const key = p.node.computed
      ? ev(p.get("property") as AstPath)
      : p.node.property.type === "Identifier"
        ? p.node.property.name
        : UNKNOWN;
    if (!primitive(key)) return UNKNOWN;
    const readsProcessEnv = owner.matchesPattern("process.env") && !p.scope.getBinding("process");
    if (readsProcessEnv || owner.matchesPattern("import.meta.env")) {
      return context.readEnv(String(key), readsProcessEnv);
    }
    if (owner.isIdentifier()) {
      const binding = owner.scope.getBinding(owner.node.name);
      if (binding?.path.isImportNamespaceSpecifier()) {
        if (!binding.constant || hasMemberWrites(binding))
          return context.unknown(owner, "unsupported-write");
        const target = context.imports.resolve(
          binding.path,
          (binding.path.parent as t.ImportDeclaration).source.value,
        );
        return target ? context.exported(target, String(key), frame, depth) : UNKNOWN;
      }
    }
    const value = optional ? chained : ev(owner);
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
    if (!missing) return text;
    const separator = remoteNameSeparator(knownPrefix);
    return {
      [TAG]: "missing-template",
      name: separator > 0 ? knownPrefix.slice(0, separator) : null,
    };
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
  if (p.isCallExpression() || p.isNewExpression() || p.isOptionalCallExpression()) {
    const callee = p.get("callee") as AstPath;
    const args = p.get("arguments") as AstPath[];
    const optional = p.isOptionalCallExpression();
    const chained = optional ? context.evaluate(callee, frame, depth, true) : undefined;
    if (chained === OPTIONAL_MISS || (optional && p.node.optional && chained == null))
      return OPTIONAL_MISS;
    if (
      p.isCallExpression() &&
      callee.isIdentifier() &&
      !callee.scope.getBinding(callee.node.name)
    ) {
      if (callee.node.name === "Number" || callee.node.name === "parseInt") {
        const value = ev(args[0] ?? null);
        if (!primitive(value) || args.some((arg) => arg.isSpreadElement())) return UNKNOWN;
        if (args.length > (callee.node.name === "Number" ? 1 : 2)) return UNKNOWN;
        if (callee.node.name === "Number") return args.length ? Number(value) : 0;
        const radix = ev(args[1] ?? null);
        return primitive(radix) ? Number.parseInt(String(value), Number(radix)) : UNKNOWN;
      }
    }
    if (isConfigApi(callee, PLUGINS)) {
      const options = ev((args[0] as AstPath) ?? null);
      context.plugins.add(options);
      return options;
    }
    if (isConfigApi(callee, CONFIG_FACTORIES)) {
      const config = ev(args[0] ?? null);
      if (config && typeof config === "object") {
        const source = apiReference(callee)?.source;
        if (source === "@rsbuild/core")
          context.configOrigins.set(config, { bundler: "rsbuild", direct: true });
        if (source === "vite") context.configOrigins.set(config, { bundler: "vite", direct: true });
      }
      return config;
    }
    const reference = apiReference(callee);
    const method = reference?.members.length === 1 ? reference.members[0] : undefined;
    if (p.isCallExpression() && reference?.source === "dotenv" && method === "parse") {
      const input = args[0];
      if (input?.isCallExpression()) {
        const read = apiReference(input.get("callee") as AstPath);
        if (
          (read?.source === "fs" || read?.source === "node:fs") &&
          read.members.length === 1 &&
          read.members[0] === "readFileSync"
        ) {
          const readArgs = input.get("arguments") as AstPath[];
          const options = ev(readArgs[1] ?? null);
          const encoding = object(options) ? options.encoding : options;
          if (
            args.length !== 1 ||
            readArgs.length > 2 ||
            ![undefined, null, "utf8", "utf-8"].includes(encoding as string | null | undefined)
          )
            return context.unknown(input, "unresolved-env-file");
          const file = ev(readArgs[0] ?? null);
          const text = typeof file === "string" ? context.imports.readEnvText(file) : null;
          return text === null ? context.unknown(input, "unresolved-env-file") : parseEnv(text);
        }
      }
      const text = ev(input ?? null);
      return typeof text === "string" ? parseEnv(text) : context.unknown(p, "unresolved-env-file");
    }
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
      return context.unknown(p, "unresolved-output-path");
    }
    if (
      callee.isIdentifier({ name: "require" }) &&
      !callee.scope.getBinding("require") &&
      args[0]?.isStringLiteral()
    ) {
      const source = args[0].node.value;
      if (source.endsWith(".json")) {
        const value = context.imports.readJson(p, source);
        return value === undefined ? UNKNOWN : value;
      }
      const target = context.imports.resolve(p, source);
      return target ? context.exported(target, "default", frame, depth) : UNKNOWN;
    }
    const fn = optional ? chained : ev(callee);
    if (!fn || typeof fn !== "object" || !(TAG in fn) || fn[TAG] !== "function")
      return context.unknown(p, "unsupported-call");
    const values: Value[] = [];
    for (const arg of args) {
      if (!arg.isSpreadElement()) values.push(ev(arg));
      else if (!context.appendArraySpread(values, ev(arg.get("argument")), arg)) return UNKNOWN;
    }
    return context.call(fn, values, depth);
  }
  return context.unknown(p);
}
