import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { parseTsconfig, type TsConfigJsonResolved } from "get-tsconfig";
import {
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { errorMessage } from "../../../shared/lib/errors.ts";
import { LocatedError } from "../../../shared/models/source-problem.ts";

export function readSourceConfig(file: string): TsConfigJsonResolved {
  // Fresh library cache observes edits to every inherited config and package.json.
  const cache = new Map<string, string>();
  try {
    let config: TsConfigJsonResolved | undefined;
    let loadError: unknown;
    try {
      config = parseTsconfig(file, cache);
    } catch (error) {
      loadError = error;
    }
    const missing = /^File '(.+)' not found\.$/.exec(errorMessage(loadError))?.[1];
    let missingExtends: LocatedError | undefined;
    // get-tsconfig recovers malformed JSONC. Validate all raw inputs before using its result.
    // Its readFileSync cache keys are covered by inherited-config tests; keep the version pinned.
    for (const [key, text] of cache) {
      if (!key.startsWith("readFileSync:") || typeof text !== "string") continue;
      const source = key.slice("readFileSync:".length, -":utf8".length);
      const invalid = (message: string, keyPath: string[] = []): never => {
        const tree = parseTree(text);
        const offset = tree ? (findNodeAtLocation(tree, keyPath)?.offset ?? 0) : 0;
        throw configError(file, source, text, offset, message);
      };
      const errors: ParseError[] = [];
      const value: unknown = parseJsonc(text, errors, {
        allowTrailingComma: true,
        allowEmptyContent: true,
      });
      if (errors.length) {
        const issue = errors[0];
        throw configError(file, source, text, issue.offset, printParseErrorCode(issue.error));
      }
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
        invalid("Expected a JSON object");
      if (value === undefined) continue;
      if (/[/\\]package\.json:utf8$/.test(key) && key !== `readFileSync:${file}:utf8`) continue;
      const raw = value as Record<string, unknown>;
      const inherited = raw.extends;
      if (
        missing &&
        (inherited === missing || (Array.isArray(inherited) && inherited.includes(missing))) &&
        !resolvesRelativeExtends(source, missing)
      ) {
        const tree = parseTree(text);
        const keyPath = Array.isArray(inherited)
          ? ["extends", inherited.lastIndexOf(missing)]
          : ["extends"];
        const offset = tree ? (findNodeAtLocation(tree, keyPath)?.offset ?? 0) : 0;
        missingExtends = configError(file, source, text, offset, errorMessage(loadError));
      }
      if (
        inherited !== undefined &&
        typeof inherited !== "string" &&
        (!Array.isArray(inherited) || inherited.some((value) => typeof value !== "string"))
      )
        invalid("Invalid extends", ["extends"]);
      for (const field of ["files", "include", "exclude"] as const) {
        const values = raw[field];
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
          invalid(`Invalid ${field}`, [field]);
        if (field === "files") continue;
        for (const pattern of values as string[]) {
          const parts = pattern.replaceAll("\\", "/").split("/");
          const recursive = parts.indexOf("**");
          if (
            (field === "include" && /(?:^|\/)\*\*\/?$/.test(parts.join("/"))) ||
            (recursive >= 0 && parts.slice(recursive + 1).includes(".."))
          )
            invalid(`Invalid ${field} pattern`, [field]);
        }
      }
      const options = raw.compilerOptions;
      if (options !== undefined) {
        if (!options || typeof options !== "object" || Array.isArray(options))
          invalid("Invalid compilerOptions", ["compilerOptions"]);
        for (const field of ["outDir", "declarationDir"] as const) {
          const option = (options as Record<string, unknown>)[field];
          if (option !== undefined && typeof option !== "string")
            invalid(`Invalid ${field}`, ["compilerOptions", field]);
        }
      }
    }
    if (!config) throw missingExtends ?? loadError;
    return config;
  } catch (error) {
    if (error instanceof LocatedError) throw error;
    throw new LocatedError(
      `Invalid tsconfig: ${file}`,
      [
        {
          file,
          line: 1,
          column: 1,
          message: errorMessage(error),
        },
      ],
      { cause: error },
    );
  }
}

function resolvesRelativeExtends(source: string, specifier: string): boolean {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return false;
  const target = path.resolve(
    path.dirname(source),
    specifier === ".." ? "../tsconfig.json" : specifier,
  );
  const entry = statSync(target, { throwIfNoEntry: false });
  return entry ? entry.isFile() : !target.endsWith(".json") && existsSync(`${target}.json`);
}

function configError(config: string, file: string, text: string, offset: number, message: string) {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return new LocatedError(`Invalid tsconfig: ${config}`, [
    {
      file,
      line: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
      message,
    },
  ]);
}
