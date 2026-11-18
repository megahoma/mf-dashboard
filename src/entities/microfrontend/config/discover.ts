const CONFIG_EXTENSIONS = "(?:mjs|cjs|js|mts|cts|ts|jsx|tsx)";

export const FEDERATION_CONFIG_PREFIX =
  /^(module-federation|webpack|rspack|rsbuild|rslib|vite)\.config\./;
export const CONFIG_EXTENSION = new RegExp(`\\.${CONFIG_EXTENSIONS}$`);
export const CONFIG_FILE = new RegExp(`${FEDERATION_CONFIG_PREFIX.source}${CONFIG_EXTENSIONS}$`);

export const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist"]);

export const RSLIB_CONFIG_NAMES = ["mjs", "ts", "js", "cjs", "mts", "cts"].map(
  (extension) => `rslib.config.${extension}`,
);
export const VITE_CONFIG_NAMES = ["js", "mjs", "ts", "cjs", "mts", "cts"].map(
  (extension) => `vite.config.${extension}`,
);

const CAC_GLOBAL_SWITCHES = ["help", "h", "version", "v"];

export const RSLIB_CAC_SWITCHES = new Set([...CAC_GLOBAL_SWITCHES, "env"]);

const VITE_GLOBAL_SWITCHES = [...CAC_GLOBAL_SWITCHES, "clearScreen"];

const RSBUILD_GLOBAL_SWITCHES = [...CAC_GLOBAL_SWITCHES, "env", "sourceMap"];

export const CAC_COMMAND_SWITCHES = {
  vite: {
    build: new Set([...VITE_GLOBAL_SWITCHES, "emptyOutDir", "watch", "w", "app"]),
    preview: new Set([...VITE_GLOBAL_SWITCHES, "strictPort"]),
  },
  rsbuild: {
    build: new Set([...RSBUILD_GLOBAL_SWITCHES, "watch", "w"]),
    preview: new Set([...RSBUILD_GLOBAL_SWITCHES, "strictPort"]),
  },
};
