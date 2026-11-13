import path from "node:path";
import { CAC_COMMAND_SWITCHES } from "../config/discover.ts";
import { readConfigInput } from "./config-input.ts";

export function readLaunchScript(
  dir: string,
  scriptName: string,
  dependencies?: Set<string>,
): {
  program: string;
  env: Record<string, string>;
  mode?: string;
  command?: string;
  configFile?: string;
  noEnv: boolean;
} | null {
  const file = path.join(dir, "package.json");
  dependencies?.add(file);
  try {
    const text = readConfigInput(file, 512 * 1024);
    if (text === null) return null;
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    if (!pkg.scripts || !Object.hasOwn(pkg.scripts, scriptName)) return null;
    const script = pkg.scripts[scriptName];
    if (typeof script !== "string" || !/^[\w.@:/=+\- \t]+$/.test(script)) return null;
    const words = script.trim().split(/\s+/);
    let index = words[0] === "cross-env" ? 1 : 0;
    const env: Record<string, string> = Object.create(null);
    for (; index < words.length; index++) {
      const pair = /^([A-Za-z_][\w]*)=(.*)$/.exec(words[index]);
      if (!pair) break;
      env[pair[1]] = pair[2];
    }
    const program = (words[index] ?? "").replace(/\.cmd$/, "");
    if (!/^(rsbuild|vite|rspack|webpack)$/.test(program)) return null;
    const separator = words.indexOf("--", index + 1);
    const args = words.slice(index + 1, separator === -1 ? undefined : separator);
    const action = program === "vite" || program === "rsbuild" ? cacAction(args, program) : args[0];
    const command = action === "build" || action === "preview" ? action : undefined;
    const modeFlags =
      program === "rsbuild" ? ["--env-mode"] : program === "vite" ? ["--mode", "-m"] : [];
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
        program === "rsbuild" || program === "vite" ? ["--config", "-c"] : ["--config"],
      ),
      noEnv: program === "rsbuild" && args.includes("--no-env"),
    };
  } catch {
    return null;
  }
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
