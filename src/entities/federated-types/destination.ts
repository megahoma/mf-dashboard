import fs from "node:fs";
import path from "node:path";
import { DiagnosticError } from "../../shared/diagnostic-error.ts";

export function typesPathEscape(message = "types path escapes the consumer"): DiagnosticError {
  return new DiagnosticError(message, { stage: "destination", reason: "path-escape" });
}

function relativeInside(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw typesPathEscape();
  return relative;
}

// Resolve existing links while keeping the suffix of a path that has not been created yet.
export function resolveTypesPath(root: string, target: string, links?: Set<string>): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = relativeInside(absoluteRoot, absoluteTarget);
  if (!fs.lstatSync(absoluteRoot, { throwIfNoEntry: false })) return absoluteTarget;
  const realRoot = fs.realpathSync.native(absoluteRoot);
  if (links && realRoot !== absoluteRoot) rememberLinks(absoluteRoot, absoluteRoot, links);
  return walkTypesPath(realRoot, relative, links, realRoot);
}

function rememberLinks(file: string, from: string, links: Set<string>): void {
  const root = path.parse(file).root;
  walkTypesPath(root ? path.resolve(from, root) : from, file.slice(root.length), links);
}

function walkTypesPath(
  start: string,
  relative: string,
  links?: Set<string>,
  boundary?: string,
): string {
  let current = start;
  const parts = relative.split(process.platform === "win32" ? /[\\/]/ : "/");
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    const next = path.join(current, part);
    const stat = fs.lstatSync(next, { throwIfNoEntry: false });
    if (!stat) return path.join(fs.realpathSync.native(current), ...parts.slice(index));
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    try {
      const resolved = fs.realpathSync.native(next);
      if (links) {
        const parent = fs.realpathSync.native(current);
        const link = path.join(parent, part);
        if (!links.has(link)) {
          links.add(link);
          // Follow the link before applying any subsequent parent segments.
          rememberLinks(fs.readlinkSync(link), parent, links);
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
