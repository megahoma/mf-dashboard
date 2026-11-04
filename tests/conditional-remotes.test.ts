import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSource, readAppFolder } from "../src/entities/microfrontend/discover.ts";

test("an imported helper adds remotes according to mode env without executing config code", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-conditional-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "options"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "options", "index.ts"),
    "export { buildOptions } from './federation';",
  );
  fs.writeFileSync(
    path.join(root, "options", "federation.ts"),
    `throw new Error('config must not execute');
     const gateway = import.meta.env.PANEL_GATEWAY;
     export function buildOptions() {
       const links: Record<string, string> = {
         panel: \`canvas@\${gateway}/mf-manifest.json\`,
       };
       if (process.env.GRAPH_STAGE === 'preview' && process.env.BUNDLED_KIT !== 'yes') {
         links['toolkit'] = 'sharedKit@http://localhost:4202/mf-manifest.json';
       }
       return {
         name: 'portal', remotes: links, manifest: true,
         dts: process.env.BUNDLED_KIT === 'yes' ? false : { generateTypes: true },
       };
     }`,
  );
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    `import { buildOptions } from './options';
     export default defineConfig({
       server: { port: 4200 }, plugins: [pluginModuleFederation(buildOptions())],
     });`,
  );
  for (const [stage, bundled, aliases] of [
    ["preview", "no", ["panel", "toolkit"]],
    ["preview", "yes", ["panel"]],
    ["release", "no", ["panel"]],
  ] as const) {
    fs.writeFileSync(
      path.join(root, ".env.preview"),
      `GRAPH_STAGE=${stage}\nBUNDLED_KIT=${bundled}\nPANEL_GATEWAY=http://localhost:4201`,
    );
    const app = readAppFolder(root, "preview");
    assert.equal(app?.name, "portal");
    assert.equal(app.port, 4200);
    assert.deepEqual(
      app.remotes.map((link) => link.alias),
      aliases,
    );
    assert.deepEqual(app.remotes[0], {
      alias: "panel",
      name: "canvas",
      url: "http://localhost:4201/mf-manifest.json",
    });
    if (aliases.length === 2) assert.equal(app.remotes[1].name, "sharedKit");
    assert.equal(app.generateTypes, bundled !== "yes");
    assert.equal(app.consumeTypes, bundled !== "yes");
  }
});

test("local remote assignments use statement order, computed keys and the selected else branch", () => {
  const source = `function buildOptions() {
    const links = { panel: 'initial@http://localhost:4201/mf-manifest.json' };
    const slot = 'panel';
    links[slot] = 'first@http://localhost:4202/mf-manifest.json';
    if (process.env.SELECT_ALT === 'yes') {
      links.panel = 'second@http://localhost:4203/mf-manifest.json';
    } else {
      links.panel = 'fallback@http://localhost:4204/mf-manifest.json';
    }
    const snapshot = { ...links };
    links.panel = 'later@http://localhost:4205/mf-manifest.json';
    return { name: 'portal', remotes: snapshot };
  }
  export default pluginModuleFederation(buildOptions());`;
  for (const [selected, expected] of [
    ["yes", "second"],
    ["no", "fallback"],
  ]) {
    const app = discoverSource(source, path.resolve("rsbuild.config.ts"), { SELECT_ALT: selected });
    assert.equal(app?.remotes[0]?.name, expected);
  }
});

test("a false outer branch does not need to resolve a nested condition", () => {
  const source = `function buildOptions() {
    const links = { panel: 'canvas@http://localhost:4201/mf-manifest.json' };
    if (false) { if (unavailable()) { links.panel = 'unused'; } }
    return { name: 'portal', remotes: links };
  }
  export default pluginModuleFederation(buildOptions());`;
  assert.equal(
    discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes[0]?.name,
    "canvas",
  );
});

test("unsupported mutations and unresolved branches do not publish obsolete remote links", () => {
  for (const statements of [
    "if (unavailable()) { links.panel = 'changed'; }",
    "for (const key of ['panel']) { links[key] = 'changed'; }",
    "links.panel += '/changed';",
    "delete links.panel;",
    "links.panel.entry = 'changed';",
    "links[unavailable()] = 'changed';",
    "const copy = links; copy.panel = 'changed';",
    "const copy = links; links.panel = 'changed';",
    "function update() { links.panel = 'changed'; }",
    "externalUpdate(links); links.panel = 'changed';",
    "links.panel = 'changed'; links.refresh();",
    "links.panel = 'changed'; const holder = { value: links }; holder.value.panel = 'later';",
  ]) {
    const source = `function buildOptions() {
      const links = { panel: 'canvas@http://localhost:4201/mf-manifest.json' };
      ${statements}
      return { name: 'portal', remotes: links };
    }
    export default pluginModuleFederation(buildOptions());`;
    assert.deepEqual(
      discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes,
      [],
      statements,
    );
  }
});
