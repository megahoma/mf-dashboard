import path from "node:path";

export function isConfinedRelativePath(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function pathIsInside(root: string, file: string): boolean {
  return isConfinedRelativePath(path.relative(root, file));
}

export function isTypeScriptSource(file: string): boolean {
  return /\.tsx?$/.test(file) && !file.endsWith(".d.ts");
}
