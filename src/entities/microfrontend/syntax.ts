import { parse, type ParserPlugin } from "@babel/parser";
import traverseModule, { type NodePath } from "@babel/traverse";
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
}

function commonJsRoot(write: AstPath, target: AstPath): AstPath | null {
  if (write.getFunctionParent() || !target.isMemberExpression()) return null;
  let root: AstPath = target;
  while (root.isMemberExpression() && !root.matchesPattern("module.exports"))
    root = root.get("object");
  return (root.matchesPattern("module.exports") && !write.scope.getBinding("module")) ||
    (root.isIdentifier({ name: "exports" }) && !write.scope.getBinding("exports"))
    ? root
    : null;
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
        program = { file, root, calls: [], exports: new Map(), stars: [], default: null };
      },
      "CallExpression|NewExpression"(p) {
        program!.calls.push(p);
      },
      ExportDefaultDeclaration(p) {
        program!.default = p.get("declaration");
        program!.exports.set("default", p.get("declaration"));
      },
      ExportNamedDeclaration(p) {
        const declaration = p.get("declaration");
        if (declaration.isVariableDeclaration()) {
          for (const variable of declaration.get("declarations")) {
            const id = variable.get("id");
            if (id.isIdentifier())
              program!.exports.set(id.node.name, variable.get("init") as AstPath);
          }
        } else if (declaration.isFunctionDeclaration() && declaration.node.id) {
          program!.exports.set(declaration.node.id.name, declaration);
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
      AssignmentExpression(p) {
        const left = p.get("left");
        const root = commonJsRoot(p, left);
        if (!root) return;
        const moduleExport = root.matchesPattern("module.exports");
        if (
          !p.parentPath.isExpressionStatement() ||
          !p.parentPath.parentPath?.isProgram() ||
          p.node.operator !== "=" ||
          (moduleExport && root.node !== left.node) ||
          (!moduleExport && left.isMemberExpression() && left.get("object").node !== root.node)
        ) {
          uncertainExports = p;
          return;
        }
        if (moduleExport) {
          program!.default = p.get("right");
          program!.exports.set("default", p.get("right"));
        } else if (left.isMemberExpression()) {
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
