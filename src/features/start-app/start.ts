import fs from "node:fs";
import path from "node:path";

export function lookupScript(
  scripts: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (scripts == null || !Object.prototype.hasOwnProperty.call(scripts, key)) return null;
  const body = scripts[key];
  return typeof body === "string" ? body : null;
}

export function resolvePackageManager(root: string, configured: string): "npm" | "pnpm" {
  if (configured === "npm" || configured === "pnpm") return configured;
  const declared = packageManagerField(path.join(root, "package.json"));
  if (declared) return declared;
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return "npm";
}

export interface StartInvocation {
  command: "npm" | "pnpm";
  args: ["run", string];
  cwd: string;
}

// The script body is only a presence check. The process is `<packageManager> run <key>`.
export function startInvocation(input: {
  packageManager: "npm" | "pnpm";
  scriptKey: string;
  scriptBody: string | null;
  cwd: string;
  portOpen: boolean;
}): StartInvocation | null {
  if (input.portOpen || input.scriptBody == null || !/^[\w.:-]+$/.test(input.scriptKey))
    return null;
  return { command: input.packageManager, args: ["run", input.scriptKey], cwd: input.cwd };
}

function packageManagerField(file: string): "npm" | "pnpm" | null {
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { packageManager?: unknown };
    if (typeof pkg.packageManager !== "string") return null;
    const name = pkg.packageManager.split("@")[0];
    if (name === "pnpm" || name === "npm") return name;
    return null;
  } catch {
    return null;
  }
}
