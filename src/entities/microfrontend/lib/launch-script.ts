import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../../../shared/lib/record.ts";
import { CAC_COMMAND_SWITCHES, RSLIB_CAC_SWITCHES } from "../config/discover.ts";
import type { ConfigInput } from "../models/config.ts";
import { readConfigInput } from "./config-input.ts";

// A missing package has no scripts. An unreadable package cannot prove that a script is absent.
export function readPackageScripts(
  dir: string,
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
): Record<string, unknown> | null {
  const file = path.join(dir, "package.json");
  dependencies?.add(file);
  try {
    const text = readConfigInput(file, 512 * 1024, { inputs });
    if (text === null) return fs.lstatSync(file, { throwIfNoEntry: false }) ? null : {};
    const pkg: unknown = JSON.parse(text);
    if (!isRecord(pkg)) return null;
    return isRecord(pkg.scripts) ? pkg.scripts : {};
  } catch {
    return null;
  }
}

export function readLaunchScript(
  dir: string,
  scriptName: string,
  dependencies?: Set<string>,
  inputs?: Map<string, ConfigInput>,
) {
  const scripts = readPackageScripts(dir, dependencies, inputs);
  return scripts && Object.hasOwn(scripts, scriptName)
    ? parseLaunchScript(scripts[scriptName])
    : null;
}

export function parseLaunchScript(script: unknown): {
  program: string;
  env: Record<string, string>;
  mode?: string;
  command?: string;
  configFile?: string;
  viteBase?: string;
  root?: string;
  envDir?: string;
  noEnv: boolean;
} | null {
  try {
    const literal = process.platform === "win32" ? /^[\w.@:/\\=+\- \t]+$/ : /^[\w.@:/=+\- \t]+$/;
    if (typeof script !== "string" || !literal.test(script)) return null;
    const words = script.trim().split(/\s+/);
    let index = words[0] === "cross-env" ? 1 : 0;
    const env: Record<string, string> = Object.create(null);
    for (; index < words.length; index++) {
      const pair = /^([A-Za-z_][\w]*)=(.*)$/.exec(words[index]);
      if (!pair) break;
      if (pair[2].includes("\\")) return null;
      env[pair[1]] = pair[2];
    }
    const program = (words[index] ?? "").replace(/\.cmd$/, "");
    if (!/^(rsbuild|rslib|vite|rspack|webpack)$/.test(program)) return null;
    const separator = words.indexOf("--", index + 1);
    const args = words.slice(index + 1, separator === -1 ? undefined : separator);
    const action =
      program === "vite" || program === "rsbuild"
        ? cacAction(args, program)
        : program === "rslib"
          ? cacPositional(args, RSLIB_CAC_SWITCHES)
          : args[0];
    if (program === "rslib" && action !== "mf-dev") return null;
    const command = action === "build" || action === "preview" ? action : undefined;
    const modeFlags =
      program === "rsbuild" || program === "rslib"
        ? ["--env-mode"]
        : program === "vite"
          ? ["--mode", "-m"]
          : [];
    const requestedMode = launchOption(args, modeFlags);
    const mode =
      requestedMode && /^[\w-]+(?:\.[\w-]+)*$/.test(requestedMode) ? requestedMode : undefined;
    return {
      program,
      env,
      mode,
      command,
      configFile: launchOption(
        args,
        program === "rsbuild" || program === "vite" || program === "rslib"
          ? ["--config", "-c"]
          : ["--config"],
      ),
      viteBase: program === "vite" ? launchOption(args, ["--base"]) : undefined,
      root: program === "rslib" ? launchOption(args, ["--root", "-r"]) : undefined,
      envDir: program === "rslib" ? launchOption(args, ["--env-dir"]) : undefined,
      noEnv: (program === "rsbuild" || program === "rslib") && disablesEnv(args),
    };
  } catch {
    return null;
  }
}

function disablesEnv(args: readonly string[]): boolean {
  let env: boolean | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--no-env") {
      env = false;
      continue;
    }
    if (!arg.startsWith("-") || arg.startsWith("--no-")) continue;
    const [flag, attached] = arg.split("=", 2);
    const next = args[index + 1];
    const value = attached || (next?.startsWith("-") ? undefined : next);
    if (!attached && value !== undefined) index++;
    // CAC appends repeated positive options, but a negated option overwrites the value.
    if (flag === "--env") env = env !== undefined || value !== "false";
  }
  return env === false;
}

function cacAction(
  args: readonly string[],
  program: keyof typeof CAC_COMMAND_SWITCHES,
): string | undefined {
  const { build, preview } = CAC_COMMAND_SWITCHES[program];
  // CAC keeps the last matching command. Both tools register preview after build.
  if (cacPositional(args, preview) === "preview") return "preview";
  if (cacPositional(args, build) === "build") return "build";
}

function cacPositional(args: readonly string[], switches: ReadonlySet<string>): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) return arg;
    if (arg.startsWith("--no-")) continue;
    const [flag, attached] = arg.split("=", 2);
    const name = flag.startsWith("--") ? flag.slice(2) : flag.slice(-1);
    const next = args[index + 1];
    const value = attached || (next?.startsWith("-") ? undefined : next);
    if (value === undefined) continue;
    if (switches.has(name) && value !== "true" && value !== "false") return value;
    if (!attached) index++;
  }
}

function launchOption(args: string[], flags: string[]): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    const flag = flags.find((option) => word === option || word.startsWith(option + "="));
    if (!flag) continue;
    const value = word === flag ? args[++index] : word.slice(flag.length + 1);
    if (value && !value.startsWith("-")) result = value;
  }
  return result;
}
