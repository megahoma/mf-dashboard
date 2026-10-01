import { spawn } from "node:child_process";

const TOKENS = ["folder", "name", "port", "tsconfig", "typesFolder"] as const;

// One shell word. A federation name or path cannot close the quote and run another command.
export function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fillTemplate(
  template: string,
  values: Partial<Record<(typeof TOKENS)[number], string>>,
): string {
  return template.replace(
    /\{(folder|name|port|tsconfig|typesFolder)\}/g,
    (token, key: (typeof TOKENS)[number]) => {
      const value = values[key];
      return value == null ? token : shellQuote(value);
    },
  );
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
      reject(new Error(`timeout ${timeoutMs}`));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
