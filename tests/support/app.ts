import path from "node:path";
import type { LocalApp } from "../../src/entities/microfrontend/index.ts";

export function localApp(
  name: string,
  folder: string,
  overrides: Partial<LocalApp> = {},
): LocalApp {
  return {
    name,
    folder,
    configFile: path.join(folder, "rsbuild.config.ts"),
    port: 4100,
    manifest: true,
    generateTypes: true,
    consumeTypes: false,
    typesFolder: "@mf-types",
    tsconfig: null,
    manifestPath: "/mf-manifest.json",
    compilerInstance: null,
    remotes: [],
    ...overrides,
  };
}

export function developmentFederationConfig(specifier: string): string {
  return `import federation from ${JSON.stringify(specifier)};
    export default { lib: process.env.NODE_ENV === 'production'
      ? [{ format: 'esm' }]
      : [{ format: 'mf', plugins: [pluginModuleFederation(federation)] }] };`;
}
