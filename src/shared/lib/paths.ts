import path from "node:path";

export function isConfinedRelativePath(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function pathIsInside(root: string, file: string): boolean {
  return isConfinedRelativePath(path.relative(root, file));
}

// Keep whitespace in file names when a path setting is trimmed before resolution.
export function protectPathWhitespace(file: string): string {
  const prefixed = /^\s/.test(file) ? `./${file}` : file;
  return /\s$/.test(file) ? `${prefixed}/.` : prefixed;
}

// Native real paths already express the filesystem's casing for existing entries.
export function canonicalPathIsInside(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

export function isTypeScriptSource(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith(".d.ts");
}
