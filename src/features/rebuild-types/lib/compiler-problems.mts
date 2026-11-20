import childProcess, {
  type ExecFileOptionsWithStringEncoding,
  type ForkOptions,
} from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { LocatedError, type SourceProblem } from "../../../shared/models/source-problem.ts";

export const COMPILER_OUTPUT_LIMIT = 1024 * 1024;
const SDK_WORKER = /^fork-generate-dts\.[cm]?js$/;
const OBSERVE_SDK_WORKER = "MF_DASHBOARD_OBSERVE_SDK_COMPILER";

export function compilerProblems(output: string, cwd: string): SourceProblem[] {
  const problems = new Map<string, SourceProblem>();
  for (const text of stripVTControlCharacters(output.slice(0, COMPILER_OUTPUT_LIMIT)).split(
    /\r?\n/,
  )) {
    const match =
      /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(text) ??
      /^(.+):(\d+):(\d+) - error (TS\d+): (.+)$/.exec(text);
    if (!match) continue;
    const [, name, line, column, code, message] = match;
    const file = path.resolve(cwd, name);
    // The SDK can report the same option error in the source and its generated project file.
    if (/[\\/]node_modules[\\/]\.federation[\\/]tsconfig\.[0-9a-f]{32}\.json$/i.test(file))
      continue;
    try {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    } catch {
      continue;
    }
    const problem = { file, line: Number(line), column: Number(column), code, message };
    if (
      !Number.isSafeInteger(problem.line) ||
      problem.line < 1 ||
      !Number.isSafeInteger(problem.column) ||
      problem.column < 1
    )
      continue;
    problems.set(JSON.stringify(problem), problem);
    if (problems.size === 200) break;
  }
  return [...problems.values()];
}

function observeCompilerFailures(receive: (problems: SourceProblem[]) => void): () => void {
  // The SDK wraps execFile failures and drops their output. Capture it in the per-app process.
  const original = childProcess.execFile;
  const run = promisify(original);
  const wrapped = original.bind(childProcess) as typeof original;
  Object.defineProperty(wrapped, promisify.custom, {
    value: (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => {
      const execution = run(file, args, options);
      if (!Array.isArray(args) || !args.includes("--project")) return execution;
      const observed = execution.catch((error: unknown) => {
        const cwd = options?.cwd;
        const failure = error as { stdout?: unknown; stderr?: unknown } | null;
        const output = [failure?.stdout, failure?.stderr]
          .map((value) =>
            typeof value === "string" || Buffer.isBuffer(value) ? String(value) : "",
          )
          .join("\n");
        const problems = compilerProblems(
          output,
          cwd instanceof URL ? fileURLToPath(cwd) : (cwd ?? process.cwd()),
        );
        if (problems.length) receive(problems);
        throw error;
      });
      return Object.assign(observed, { child: execution.child });
    },
  });
  childProcess.execFile = wrapped;
  return () => {
    childProcess.execFile = original;
  };
}

export function observeSdkWorker(): boolean {
  if (
    process.env[OBSERVE_SDK_WORKER] !== "1" ||
    !SDK_WORKER.test(path.basename(process.argv[1] ?? "")) ||
    !process.send
  )
    return false;
  let problems: SourceProblem[] | undefined;
  observeCompilerFailures((errors) => {
    problems = errors;
  });
  const send = process.send;
  process.send = ((message: unknown, ...args: unknown[]) => {
    const reply =
      problems && message && typeof message === "object"
        ? { ...message, mfDashboardCompilerProblems: problems }
        : message;
    return Reflect.apply(send, process, [reply, ...args]);
  }) as typeof send;
  return true;
}

export async function captureCompilerProblems<T>(work: () => Promise<T>): Promise<T> {
  let problems: SourceProblem[] = [];
  const stop = observeCompilerFailures((errors) => {
    problems = errors;
  });
  const fork = childProcess.fork;
  // The SDK can put compilation in another child. Decorate its existing IPC reply so its RPC protocol stays intact.
  childProcess.fork = ((
    module: string | URL,
    args?: readonly string[] | ForkOptions,
    options?: ForkOptions,
  ) => {
    const file = module instanceof URL ? fileURLToPath(module) : module;
    const argv = Array.isArray(args) ? args : [];
    const settings = (Array.isArray(args) ? options : (args ?? options)) as ForkOptions | undefined;
    if (!SDK_WORKER.test(path.basename(file))) return fork(module, argv, settings);
    const observer =
      typeof __dirname === "string"
        ? pathToFileURL(path.join(__dirname, "generate-process.js"))
        : new URL("../generate-process.ts", import.meta.url);
    const child = fork(module, argv, {
      ...settings,
      execArgv: [...(settings?.execArgv ?? process.execArgv), "--import", observer.href],
      env: { ...(settings?.env ?? process.env), [OBSERVE_SDK_WORKER]: "1" },
    });
    child.prependListener(
      "message",
      (message: { mfDashboardCompilerProblems?: SourceProblem[] } | null) => {
        if (message?.mfDashboardCompilerProblems?.length)
          problems = message.mfDashboardCompilerProblems;
      },
    );
    return child;
  }) as typeof fork;
  try {
    return await work();
  } catch (error) {
    if (problems.length) throw new LocatedError(errorMessage(error), problems, { cause: error });
    throw error;
  } finally {
    childProcess.fork = fork;
    stop();
  }
}
