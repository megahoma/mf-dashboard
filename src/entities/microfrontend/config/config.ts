export const UNKNOWN = Symbol("unknown");

export const NO_RETURN = Symbol("no-return");

export const OPTIONAL_MISS = Symbol("optional-miss");

export const TAG = Symbol("static-value");

export const PLUGINS = new Set([
  "pluginModuleFederation",
  "ModuleFederationPlugin",
  "createModuleFederationConfig",
  "federation",
]);

export const CONTROLS = new Set([
  "IfStatement",
  "SwitchStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "TryStatement",
]);

export const MAX_EVALUATION_STEPS = 50_000;
export const MAX_EVALUATION_DEPTH = 64;
export const MAX_SPREAD_ITEMS = 1_000_000;
export const CONFIG_FACTORIES = new Set(["defineConfig"]);
export const CONFIG_API_PACKAGES = new Set(["@rsbuild/core", "@rspack/core", "webpack", "vite"]);
export const CONTAINER_PACKAGES = new Set(["webpack", "@rspack/core"]);
export const MF_PACKAGE = /^@module-federation\//;
export const FEDERATION_OPTION_KEYS = ["name", "remotes", "exposes", "dts", "manifest", "filename"];
