import type { Binding } from "@babel/traverse";
import type { UNKNOWN } from "../config/config.ts";
import type { ConfigImports } from "../lib/config-imports.ts";
import type { ConfigOrigin, FunctionValue, Value } from "./config.ts";
import type { AstPath, Program } from "./syntax.ts";

export type ExpressionContext = {
  imports: ConfigImports;
  configOrigins: WeakMap<object, ConfigOrigin>;
  origins: WeakMap<object, string>;
  plugins: Set<Value>;
  evaluate(
    path: AstPath | null,
    frame: Map<Binding, Value>,
    depth: number,
    inChain?: boolean,
  ): Value;
  exported(program: Program, name: string, frame: Map<Binding, Value>, depth: number): Value;
  localObject(binding: Binding, path: AstPath, frame: Map<Binding, Value>, depth: number): Value;
  call(fn: FunctionValue, args: Value[], depth: number): Value;
  unknown(path: AstPath, reason?: string): typeof UNKNOWN;
  appendArraySpread(target: Value[], value: Value, site: AstPath): boolean;
  readEnv(name: string, fromProcess: boolean): string | typeof UNKNOWN | undefined;
};
