import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("a return keeps the remotes computed before later writes", () => {
  const source = `function buildOptions() {
    const remotes = { panel: 'canvas@http://localhost:4201/mf-manifest.json' };
    if (process.env.PREVIEW === 'yes') return { name: 'portal', remotes };
    remotes.panel = 'fallback@http://localhost:4202/mf-manifest.json';
    return { name: 'portal', remotes };
    remotes.panel = 'unreachable';
  }
  export default pluginModuleFederation(buildOptions());`;
  for (const [preview, expected] of [
    ["yes", "canvas"],
    ["no", "fallback"],
  ]) {
    const app = discoverSource(source, path.resolve("rsbuild.config.ts"), { PREVIEW: preview });
    assert.equal(app?.remotes[0]?.name, expected);
  }
});

test("optional and wrapped member calls never publish obsolete remote links", () => {
  for (const call of [
    "links.refresh?.();",
    "links.refresh!();",
    "(links.refresh as () => void)();",
    "(links.refresh satisfies (() => void))();",
    "(links.refresh<void>)();",
    "links.refresh``;",
  ]) {
    const source = `function buildOptions() {
      const links = {
        panel: 'old@http://localhost:4201/mf-manifest.json',
        refresh<T>(..._args: T[]) { this.panel = 'new@http://localhost:4202/mf-manifest.json'; },
      };
      links.extra = 'extra@http://localhost:4203/mf-manifest.json';
      ${call}
      return { name: 'portal', remotes: links };
    }
    export default pluginModuleFederation(buildOptions());`;
    assert.deepEqual(
      discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes,
      [],
      call,
    );
  }
});

test("assignment keys and values read the prior state and if conditions keep their entry state", () => {
  const source = `function buildOptions() {
    const links = { panel: 'canvas@http://localhost:4201' };
    links.panel = links.panel + '/mf-manifest.json';
    if (links.panel === 'canvas@http://localhost:4201/mf-manifest.json') {
      links.panel = 'updated@http://localhost:4202/mf-manifest.json';
      links.extra = 'extra@http://localhost:4203/mf-manifest.json';
    }
    links[links.extra ? 'computed' : 'wrong'] = links.panel;
    return { name: 'portal', remotes: links };
  }
  export default pluginModuleFederation(buildOptions());`;
  assert.deepEqual(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes, [
    { alias: "panel", name: "updated", url: "http://localhost:4202/mf-manifest.json" },
    { alias: "extra", name: "extra", url: "http://localhost:4203/mf-manifest.json" },
    { alias: "computed", name: "updated", url: "http://localhost:4202/mf-manifest.json" },
  ]);
});

test("object snapshots stay independent between helper invocations", () => {
  const source = `function linksFor(name) {
    const links = { panel: 'initial@http://localhost:4201/mf-manifest.json' };
    if (name !== 'off') { links.panel = name + '@http://localhost:4202/mf-manifest.json'; }
    return links;
  }
  export default pluginModuleFederation({
    name: 'portal', remotes: { ...linksFor('first'), ...linksFor('second') },
  });`;
  assert.equal(
    discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes[0]?.name,
    "second",
  );
});

test("depth-limited snapshots do not poison a later shallow read", () => {
  const chain = Array.from(
    { length: 58 },
    (_, index) => `const r${index} = ${index ? `r${index - 1}` : "links.panel"};`,
  ).join("\n");
  const source = `function buildOptions() {
    const links = { panel: 'old@http://localhost:4201/mf-manifest.json' };
    links.extra = 'extra@http://localhost:4202/mf-manifest.json';
    ${chain}
    return { name: 'portal', remotes: { deep: r57, shallow: r0 } };
  }
  export default pluginModuleFederation(buildOptions());`;
  assert.deepEqual(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes, [
    { alias: "deep", name: "deep", url: null },
    { alias: "shallow", name: "old", url: "http://localhost:4201/mf-manifest.json" },
  ]);
});

test("many object-dependent conditions finish within a bounded worker", () => {
  const count = 32;
  const writes = Array.from(
    { length: count },
    (_, index) =>
      `if (links.panel) { links.remote${index} = 'remote${index}@http://localhost:4300/mf-manifest.json'; }`,
  ).join("\n");
  const source = `function buildOptions() {
    const links = { panel: 'canvas@http://localhost:4201/mf-manifest.json' };
    ${writes}
    return { name: 'portal', remotes: links };
  }
  export default pluginModuleFederation(buildOptions());`;
  const module = new URL("../src/entities/microfrontend/config.ts", import.meta.url).href;
  const script = `import { discoverSource } from ${JSON.stringify(module)};
    const app = discoverSource(${JSON.stringify(source)}, ${JSON.stringify(path.resolve("rsbuild.config.ts"))}, {});
    process.stdout.write(JSON.stringify(app?.remotes.map(remote => remote.alias)));`;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "panel",
    ...Array.from({ length: count }, (_, index) => `remote${index}`),
  ]);
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
