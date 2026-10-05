import { parse, type ParserPlugin } from "@babel/parser";
import traverseModule, { type Binding, type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import { noLog, type LogContext } from "../../shared/logging.ts";

// CJS Babel exposes .default; the bundled extension and native ESM tests use the same entry.
const traverse =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default;
export type AstPath = NodePath<t.Node>;
export interface Program {
  file: string;
  root: NodePath<t.Program>;
  calls: AstPath[];
  exports: Map<string, AstPath | { from: string; imported: string }>;
  stars: string[];
  default: AstPath | null;
  commonJs: boolean;
}

function moduleExports(p: AstPath): boolean {
  if (!p.isMemberExpression() && !p.isOptionalMemberExpression()) return false;
  const { object, property, computed } = p.node;
  return (
    object.type === "Identifier" &&
    object.name === "module" &&
    (computed
      ? property.type === "StringLiteral" && property.value === "exports"
      : property.type === "Identifier" && property.name === "exports")
  );
}

function commonJsRoot(write: AstPath, target: AstPath): AstPath | null {
  if (write.getFunctionParent()) return null;
  let root: AstPath = target;
  while (true) {
    if ((root.isMemberExpression() || root.isOptionalMemberExpression()) && !moduleExports(root))
      root = root.get("object") as AstPath;
    else if (
      root.isParenthesizedExpression() ||
      root.isTSAsExpression() ||
      root.isTSSatisfiesExpression() ||
      root.isTSNonNullExpression() ||
      root.isTSTypeAssertion()
    )
      root = root.get("expression") as AstPath;
    else break;
  }
  return (moduleExports(root) && !write.scope.getBinding("module")) ||
    (root.isIdentifier({ name: "exports" }) && !write.scope.getBinding("exports"))
    ? root
    : null;
}

// Babel marks binding reassignment, but member writes and aliases need a separate guard.
export function hasMemberWrites(binding: Binding): boolean {
  const pending = [binding];
  const visited = new Set<Binding>();
  for (let alias = pending.pop(); alias; alias = pending.pop()) {
    if (visited.has(alias)) continue;
    visited.add(alias);
    for (const reference of alias.referencePaths) {
      let target: AstPath = reference;
      let member = false;
      while (target.parentPath) {
        const parent = target.parentPath;
        if (
          (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
          target.key === "object"
        ) {
          member = true;
        } else if (!(
          parent.isParenthesizedExpression() ||
          parent.isTSAsExpression() ||
          parent.isTSSatisfiesExpression() ||
          parent.isTSNonNullExpression() ||
          parent.isTSTypeAssertion()
        ))
          break;
        target = parent;
      }
      const parent = target.parentPath;
      if (
        member &&
        ((parent?.isAssignmentExpression() && target.key === "left") ||
          parent?.isUpdateExpression() ||
          (parent?.isUnaryExpression({ operator: "delete" }) && target.key === "argument"))
      )
        return true;
      if (parent?.isVariableDeclarator() && target.key === "init") {
        for (const name of Object.keys(parent.get("id").getBindingIdentifiers())) {
          const next = parent.scope.getBinding(name);
          if (next) pending.push(next);
        }
      }
    }
  }
  return false;
}

export function parseProgram(
  source: string,
  file: string,
  log: LogContext = noLog,
): Program | null {
  try {
    const plugins: ParserPlugin[] = [];
    if (/\.(?:ts|tsx|mts|cts)$/.test(file)) plugins.push("typescript");
    if (/\.[jt]sx$/.test(file)) plugins.push("jsx");
    const ast = parse(source, {
      sourceType: "unambiguous",
      sourceFilename: file,
      plugins,
    });
    let program: Program | undefined;
    let uncertainExports: AstPath | null = null;
    traverse(ast, {
      Program(root) {
        program = {
          file,
          root,
          calls: [],
          exports: new Map(),
          stars: [],
          default: null,
          commonJs: false,
        };
      },
      "CallExpression|NewExpression"(p) {
        program!.calls.push(p);
      },
      ExportDefaultDeclaration(p) {
        const declaration = p.get("declaration");
        const value =
          declaration.isFunctionDeclaration() && declaration.node.id
            ? (declaration.get("id") as AstPath)
            : declaration;
        program!.default = value;
        program!.exports.set("default", value);
      },
      ExportNamedDeclaration(p) {
        const declaration = p.get("declaration");
        if (declaration.isVariableDeclaration()) {
          for (const variable of declaration.get("declarations")) {
            const id = variable.get("id");
            if (id.isIdentifier()) program!.exports.set(id.node.name, id);
          }
        } else if (declaration.isFunctionDeclaration() && declaration.node.id) {
          program!.exports.set(declaration.node.id.name, declaration.get("id") as AstPath);
        }
        for (const specifier of p.get("specifiers")) {
          if (!specifier.isExportSpecifier()) continue;
          const exported = specifier.node.exported;
          const name = exported.type === "Identifier" ? exported.name : exported.value;
          const local = specifier.get("local");
          program!.exports.set(
            name,
            p.node.source
              ? { from: p.node.source.value, imported: specifier.node.local.name }
              : local,
          );
        }
      },
      ExportAllDeclaration(p) {
        program!.stars.push(p.node.source.value);
      },
      VariableDeclarator(p) {
        if (!commonJsRoot(p, p.get("init") as AstPath)) return;
        for (const name of Object.keys(p.get("id").getBindingIdentifiers())) {
          const binding = p.scope.getBinding(name);
          if (binding && hasMemberWrites(binding)) uncertainExports = p;
        }
      },
      AssignmentExpression(p) {
        const left = p.get("left");
        const root = commonJsRoot(p, left);
        if (!root) return;
        const moduleExport = moduleExports(root);
        if (
          !p.parentPath.isExpressionStatement() ||
          !p.parentPath.parentPath?.isProgram() ||
          p.node.operator !== "=" ||
          (moduleExport && root.node !== left.node) ||
          (!moduleExport && left.isIdentifier()) ||
          (!moduleExport && left.isMemberExpression() && left.get("object").node !== root.node)
        ) {
          uncertainExports = p;
          return;
        }
        if (moduleExport) {
          // A replacement disconnects the former exports object and all of its named writes.
          program!.exports.clear();
          program!.commonJs = true;
          program!.default = p.get("right");
          program!.exports.set("default", p.get("right"));
        } else if (left.isMemberExpression()) {
          if (program!.commonJs) {
            uncertainExports = p;
            return;
          }
          const key = left.get("property");
          if (!left.node.computed && key.isIdentifier())
            program!.exports.set(key.node.name, p.get("right"));
          else if (key.isStringLiteral()) program!.exports.set(key.node.value, p.get("right"));
          else uncertainExports = p;
        }
      },
      "UpdateExpression|UnaryExpression"(p) {
        if (!(p.isUpdateExpression() || (p.isUnaryExpression() && p.node.operator === "delete")))
          return;
        if (commonJsRoot(p, p.get("argument") as AstPath)) uncertainExports = p;
      },
    });
    if (program && uncertainExports) {
      // Keep an unsupported AST marker so a former unconditional export cannot be reused.
      program.default = uncertainExports;
      program.exports.clear();
      program.exports.set("default", uncertainExports);
      program.stars = [];
      log.event("trace", "config.helper.unresolved", { file, reason: "unsupported-exports-write" });
    }
    return program ?? null;
  } catch (error) {
    const failure = error as { reasonCode?: string; loc?: { line?: number; column?: number } };
    // Babel messages contain source fragments. Record only structured syntax details.
    log.event("trace", "discovery.skipped", {
      file,
      reason: "syntax-error",
      reasonCode: failure.reasonCode,
      line: failure.loc?.line,
      column: failure.loc?.column,
    });
    return null;
  }
}
