import type * as t from "@babel/types";
import { CONFIG_API_PACKAGES, CONTAINER_PACKAGES, MF_PACKAGE } from "../config/config.ts";
import type { AstPath } from "../models/syntax.ts";

// Imported or unbound known API names only; a local function with the same name is a helper.
export function isConfigApi(p: AstPath, names: ReadonlySet<string>): boolean {
  if (p.isIdentifier() && !p.scope.getBinding(p.node.name)) return names.has(p.node.name);
  const reference = apiReference(p);
  if (!reference) return false;
  const { source, members } = reference;
  if (!MF_PACKAGE.test(source) && !CONFIG_API_PACKAGES.has(source)) return false;
  if (!members.length) return names.has("federation") && MF_PACKAGE.test(source);
  return (
    names.has(members.at(-1)!) &&
    (members.length === 1 ||
      (members.length === 2 && members[0] === "container" && CONTAINER_PACKAGES.has(source)))
  );
}
// Recognize package references syntactically; never execute require from a config.
export function apiReference(p: AstPath, depth = 0): { source: string; members: string[] } | null {
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
    const owner = apiReference(p.get("object"), depth + 1);
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
  const reference = apiReference(declaration.get("init") as AstPath, depth + 1);
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
