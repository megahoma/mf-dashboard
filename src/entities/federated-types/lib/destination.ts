import fs from "node:fs";
import path from "node:path";
import { isConfinedRelativePath } from "../../../shared/lib/paths.ts";
import { DiagnosticError } from "../../../shared/models/diagnostic-error.ts";

export function typesPathEscape(message = "types path escapes the consumer"): DiagnosticError {
  return new DiagnosticError(message, { stage: "destination", reason: "path-escape" });
}

function relativeInside(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!isConfinedRelativePath(relative)) throw typesPathEscape();
  return relative;
}

// Resolve existing links while keeping the suffix of a path that has not been created yet.
export function resolveTypesPath(root: string, target: string, route?: Set<string>): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = relativeInside(absoluteRoot, absoluteTarget);
  if (!fs.lstatSync(absoluteRoot, { throwIfNoEntry: false })) return absoluteTarget;
  const realRoot = fs.realpathSync.native(absoluteRoot);
  if (route && realRoot !== absoluteRoot) rememberRoute(absoluteRoot, absoluteRoot, route);
  return walkTypesPath(realRoot, relative, route, realRoot);
}

function rememberRoute(file: string, from: string, route: Set<string>): void {
  const root = path.parse(file).root;
  walkTypesPath(root ? path.resolve(from, root) : from, file.slice(root.length), route);
}

function walkTypesPath(
  start: string,
  relative: string,
  route?: Set<string>,
  boundary?: string,
): string {
  let current = start;
  const parts = relative.split(process.platform === "win32" ? /[\\/]/ : "/");
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    if (part === "..") route?.add(current);
    const next = path.join(current, part);
    const stat = fs.lstatSync(next, { throwIfNoEntry: false });
    if (!stat) return path.join(fs.realpathSync.native(current), ...parts.slice(index));
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    try {
      const resolved = fs.realpathSync.native(next);
      if (route) {
        const parent = fs.realpathSync.native(current);
        const link = path.join(parent, part);
        if (!route.has(link)) {
          route.add(link);
          // Follow the link before applying any subsequent parent segments.
          rememberRoute(fs.readlinkSync(link), parent, route);
        }
      }
      current = resolved;
    } catch {
      throw typesPathEscape("cannot resolve types symlink");
    }
    if (boundary !== undefined) relativeInside(boundary, current);
  }
  return fs.realpathSync.native(current);
}
