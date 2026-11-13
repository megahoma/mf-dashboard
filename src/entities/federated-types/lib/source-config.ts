import { parseTsconfig, type TsConfigJsonResolved } from "get-tsconfig";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export function readSourceConfig(file: string): TsConfigJsonResolved {
  // Fresh library cache observes edits to every inherited config and package.json.
  const cache = new Map<string, string>();
  try {
    const config = parseTsconfig(file, cache);
    // get-tsconfig recovers malformed JSONC. Validate all raw inputs before using its result.
    // Its readFileSync cache keys are covered by inherited-config tests; keep the version pinned.
    for (const [key, text] of cache) {
      if (!key.startsWith("readFileSync:") || typeof text !== "string") continue;
      const errors: ParseError[] = [];
      const value: unknown = parseJsonc(text, errors, {
        allowTrailingComma: true,
        allowEmptyContent: true,
      });
      if (
        errors.length ||
        (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      )
        throw new Error("Malformed JSONC");
      if (value === undefined) continue;
      if (/[/\\]package\.json:utf8$/.test(key) && key !== `readFileSync:${file}:utf8`) continue;
      const raw = value as Record<string, unknown>;
      const inherited = raw.extends;
      if (
        inherited !== undefined &&
        typeof inherited !== "string" &&
        (!Array.isArray(inherited) || inherited.some((value) => typeof value !== "string"))
      )
        throw new Error("Invalid extends");
      for (const field of ["files", "include", "exclude"] as const) {
        const values = raw[field];
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
          throw new Error(`Invalid ${field}`);
        if (field === "files") continue;
        for (const pattern of values as string[]) {
          const parts = pattern.replaceAll("\\", "/").split("/");
          const recursive = parts.indexOf("**");
          if (
            (field === "include" && /(?:^|\/)\*\*\/?$/.test(parts.join("/"))) ||
            (recursive >= 0 && parts.slice(recursive + 1).includes(".."))
          )
            throw new Error(`Invalid ${field} pattern`);
        }
      }
      const options = raw.compilerOptions;
      if (options !== undefined) {
        if (!options || typeof options !== "object" || Array.isArray(options))
          throw new Error("Invalid compilerOptions");
        for (const field of ["outDir", "declarationDir"] as const) {
          const option = (options as Record<string, unknown>)[field];
          if (option !== undefined && typeof option !== "string")
            throw new Error(`Invalid ${field}`);
        }
      }
    }
    return config;
  } catch (error) {
    throw new Error(`Invalid tsconfig: ${file}`, { cause: error });
  }
}
