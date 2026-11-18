import type { Binding } from "@babel/traverse";
import type { UNKNOWN } from "../config/config.ts";
import type { ConfigImports } from "../lib/config-imports.ts";
import type { ConfigOrigin, FunctionValue, Value } from "./config.ts";
import type { AstPath, Program } from "./syntax.ts";

export type ExpressionContext = {
  imports: ConfigImports;
  configOrigins: WeakMap<object, ConfigOrigin>;
  origins: WeakMap<object, string>;
  federationNameOrigins: WeakMap<object, string>;
  federationNameSources: WeakMap<object, ReadonlySet<string>>;
  plugins: Map<Value, string | undefined>;
  evaluate(
    path: AstPath | null,
    frame: Map<Binding, Value>,
    depth: number,
    inChain?: boolean,
  ): Value;
  exported(program: Program, name: string, frame: Map<Binding, Value>, depth: number): Value;
  localObject(binding: Binding, path: AstPath, frame: Map<Binding, Value>, depth: number): Value;
  call(
    fn: FunctionValue,
    args: Value[],
    depth: number,
    site: AstPath,
    frame: Map<Binding, Value>,
  ): Value;
  constructionSite(site: AstPath, frame: Map<Binding, Value>): string | undefined;
  unknown(path: AstPath, reason?: string): typeof UNKNOWN;
  appendArraySpread(target: Value[], value: Value, site: AstPath): boolean;
  reserveString(length: number, site: AstPath): boolean;
  readEnv(name: string, fromProcess: boolean): string | typeof UNKNOWN | undefined;
};
