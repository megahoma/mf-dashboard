import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../src/shared/logging.ts";
import {
  discoverSource,
  readEnvFile,
  scanWorkspace,
} from "../src/entities/microfrontend/discover.ts";
import { readAppFolder } from "../src/entities/microfrontend/discover.ts";
import { createAppParseCache } from "../src/widgets/mf-dashboard-tree/session.ts";
import { mergeMissingApps } from "../src/features/init-settings/defaults.ts";

const cases: [string, string, string | null][] = [
  [
    "nested blocks without conditional returns",
    `function options() { if (true) { if (true) { const nested = () => { return {name:'decoy'} }; } } { const name='app'; return {name}; } }`,
    "app",
  ],
  [
    "conditional return",
    `function options() { if (false) { return {name:'decoy'} } return {name:'app'} }`,
    null,
  ],
  [
    "loop return",
    `function options() { for (;;) { return {name:'decoy'} } return {name:'app'} }`,
    null,
  ],
  [
    "switch return",
    `function options() { switch (1) {case 1: return {name:'decoy'}} return {name:'app'} }`,
    null,
  ],
  [
    "try return",
    `function options() { try { return {name:'decoy'} } catch {} return {name:'app'} }`,
    null,
  ],
  ["ASI", `function options() { return\n{name:'decoy'} }`, null],
  ["parameter default", `const options = (name='app') => ({name});`, "app"],
  ["helper chain", `const make = name => ({name}); const options = () => make('app');`, "app"],
  [
    "lexical shadow",
    `const name='outer'; function options() { const name='app'; { const name='decoy'; } return {name}; }`,
    "app",
  ],
  [
    "spread computed and last wins",
    `const name='app'; const base={name:'decoy',dts:false}; const options=()=>({...base,['na'+'me']:name,name:'app'});`,
    "app",
  ],
  [
    "TS wrappers and generic arrow",
    `const options = <T,>() => ({name:'app'} as const satisfies {name:string});`,
    "app",
  ],
  ["destructured constant", `const {name}={name:'app'}; const options=()=>({name});`, "app"],
  [
    "destructured helper param",
    `const make=({name}={name:'app'})=>({name}); const options=()=>make();`,
    "app",
  ],
  [
    "regex and keywords",
    `const r=/return[{}]/; const options=()=>({name:'app',if:1,return:2});`,
    "app",
  ],
  ["cycle", `const a=b,b=a; const options=()=>a;`, null],
  ["recursive helper", `const options=()=>options();`, null],
  ["async helper", `async function options() {return {name:'app'}}`, null],
  ["unresolved condition", `const options=()=>process.env.UNKNOWN?{name:'decoy'}:unknown();`, null],
  ["known condition", `const options=()=>true?{name:'app'}:{name:'decoy'};`, "app"],
  [
    "object mutation",
    `const value={name:'decoy'}; value.name='app'; const options=()=>value;`,
    null,
  ],
];
for (const [title, prelude, expected] of cases) {
  test(`Babel discovery: ${title}`, () => {
    const source = `${prelude}\nexport default defineConfig({server:{port:3001},plugins:[pluginModuleFederation(options())]});`;
    const app = discoverSource(source, path.resolve("rsbuild.config.ts"), {});
    assert.equal(app?.name ?? null, expected);
    if (app) assert.equal(app.port, 3001);
  });
}

test("a missing template value preserves only the known remote name prefix", () => {
  const source =
    "export default pluginModuleFederation({name:'app',remotes:{known:`widget@${process.env.URL}/mf-manifest.json`,unknown:`widget${process.env.SUFFIX}@http://localhost:3001/mf-manifest.json`}});";
  assert.deepEqual(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.remotes, [
    { alias: "known", name: "widget", url: null },
    { alias: "unknown", name: "unknown", url: null },
  ]);
});

test("a config can spread a statically known array of federation plugins", () => {
  const source =
    "const plugins=[pluginModuleFederation({name:'app'})]; export default defineConfig({server:{port:3001},plugins:[...plugins]});";
  const app = discoverSource(source, path.resolve("rsbuild.config.ts"), {});
  assert.equal(app?.name, "app");
  assert.equal(app?.port, 3001);
  assert.equal(
    discoverSource(
      "export default {plugins:[...unknownPlugins]};",
      path.resolve("rsbuild.config.ts"),
      {},
    ),
    null,
  );
});

test("the exported config selects its server and plugin; shadowed plugin names are not API calls", () => {
  const source = `import {pluginModuleFederation as mf} from '@module-federation/rsbuild-plugin';
    const decoy={server:{port:1234},plugins:[mf({name:'decoy'})]};
    function unused(pluginModuleFederation) {return pluginModuleFederation({name:'bad'})}
    export default defineConfig({server:{port:3001},plugins:[mf({name:'app'})]});`;
  assert.equal(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.name, "app");
  assert.equal(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.port, 3001);
  assert.equal(
    discoverSource(
      "const pluginModuleFederation = x => ({unrelated:x}); export default {plugins:[pluginModuleFederation({name:'bad'})]}",
      path.resolve("rsbuild.config.ts"),
      {},
    ),
    null,
  );
});

test("dotenv parses comments, quotes and multiline without changing process.env", () => {
  const before = { ...process.env };
  assert.deepEqual(
    readEnvFile(
      `export PORT=3001 # dev\r\nURL="http://localhost:3001/#anchor" # dev\nEMPTY=\nTEXT="a\\nb"\nMULTI='first\nsecond'`,
    ),
    {
      PORT: "3001",
      URL: "http://localhost:3001/#anchor",
      EMPTY: "",
      TEXT: "a\nb",
      MULTI: "first\nsecond",
    },
  );
  assert.ok(
    JSON.stringify({ ...process.env }) === JSON.stringify(before),
    "dotenv must not modify process.env",
  );
});

test("imports resolve helpers, namespace, CJS, barrels and CTS without executing workspace code", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-imports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "options.cts"),
    `throw new Error('not executed'); const name='app'; export const helper=()=>({name,manifest:true,remotes:{widget:process.env.URL}});`,
  );
  fs.writeFileSync(
    path.join(root, "barrel.ts"),
    `import {helper as local} from './options'; export {local as helper};`,
  );
  fs.writeFileSync(path.join(root, "cjs.cjs"), `module.exports={name:'app', manifest:true};`);
  fs.writeFileSync(path.join(root, "options-js.ts"), `export default ()=>({name:'app'});`);
  const file = path.join(root, "rsbuild.config.ts");
  fs.writeFileSync(
    path.join(root, ".env.development"),
    `PORT=3001 # local\nURL="http://localhost:3002/mf-manifest.json" # remote`,
  );
  for (const source of [
    `import {helper} from './barrel'; export default {server:{port:process.env.PORT},plugins:[pluginModuleFederation(helper())]}`,
    `import * as ns from './options'; export default {server:{port:process.env.PORT},plugins:[pluginModuleFederation(ns.helper())]}`,
    `const opts=require('./cjs.cjs'); export default {server:{port:process.env.PORT},plugins:[pluginModuleFederation(opts)]}`,
    `import opts from './options-js.js'; export default {server:{port:process.env.PORT},plugins:[pluginModuleFederation(opts())]}`,
  ]) {
    fs.writeFileSync(file, source);
    const app = scanWorkspace(root).app;
    assert.equal(app?.name, "app", source);
    assert.equal(app.port, 3001);
  }
});

test("dependency stamps track barrels, missing candidates and package boundaries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const file = path.join(root, "rsbuild.config.ts");
  fs.writeFileSync(
    file,
    `import {options} from './barrel'; export default {plugins:[pluginModuleFederation(options())]}`,
  );
  fs.writeFileSync(
    path.join(root, "barrel.ts"),
    `export * from './missing'; export {options} from './options';`,
  );
  fs.writeFileSync(path.join(root, "options.js"), `export const options=()=>({name:'app'});`);
  const dependencies = new Set<string>();
  const app = readAppFolder(root, "development", "app", dependencies)!;
  const cache = createAppParseCache();
  cache.store("app", root, "development", app, [...dependencies]);
  assert.equal(cache.lookup("app", root, "development")?.name, "app");
  assert.ok(dependencies.has(path.join(root, "options.ts")));
  fs.writeFileSync(path.join(root, "options.ts"), `export const options=()=>({name:'changed'});`);
  assert.equal(cache.lookup("app", root, "development"), null);
  assert.equal(readAppFolder(root, "development", "changed")?.name, "changed");
  fs.writeFileSync(path.join(root, "barrel.ts"), `export * from './a'; export * from './b';`);
  fs.writeFileSync(path.join(root, "a.ts"), `export * from './barrel';`);
  fs.writeFileSync(path.join(root, "b.ts"), `export const options=()=>({name:'branch'});`);
  assert.equal(readAppFolder(root, "development", "branch")?.name, "branch");
});

test("syntax errors skip one file and imports cannot escape the package through symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-safe-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(outside, "options.ts"), "export default {name:'outside'};");
  fs.symlinkSync(path.join(outside, "options.ts"), path.join(root, "options.ts"));
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    `import options from './options'; pluginModuleFederation(options)`,
  );
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    "export default { secret: 'do-not-log', bad: }",
  );
  assert.deepEqual(scanWorkspace(root), {});
  fs.writeFileSync(path.join(root, "module-federation.config.ts"), "export default {name:'kept'}");
  assert.equal(scanWorkspace(root).kept?.name, "kept");
});

test("same-root duplicates report both folders; prototype names survive discovery and merging", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-names-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["constructor", "toString", "__proto__"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "module-federation.config.ts"),
      `export default {name:${JSON.stringify(name)}}`,
    );
  }
  const found = scanWorkspace(root);
  assert.deepEqual(Object.keys(found).sort(), ["__proto__", "constructor", "toString"]);
  const merged = mergeMissingApps(
    undefined,
    Object.fromEntries(Object.keys(found).map((name) => [name, { path: name }])),
  );
  assert.ok(Object.hasOwn(merged, "__proto__"));
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  fs.mkdirSync(path.join(root, "duplicate"));
  fs.writeFileSync(
    path.join(root, "duplicate", "module-federation.config.ts"),
    "export default {name:'constructor'}",
  );
  assert.throws(
    () => scanWorkspace(root),
    (error) =>
      error instanceof Error &&
      error.message.includes(path.join(root, "constructor")) &&
      error.message.includes(path.join(root, "duplicate")),
  );
});

test("safe trace reasons distinguish syntax and conditional returns without source or env contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-reasons-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: { event: string; fields: unknown }[] = [];
  const log = createLogger({
    enabled: () => true,
    write: (_level, text) => events.push({ event: text, fields: null }),
  });
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    `const secret='TOP_SECRET'; export default {name: }`,
  );
  fs.writeFileSync(
    path.join(root, "vite.config.ts"),
    `function options() {if (false) return {name:'TOP_SECRET'}; return {name:'app'}}; pluginModuleFederation(options());`,
  );
  assert.deepEqual(scanWorkspace(root, { log }), {});
  const output = JSON.stringify(events);
  assert.match(output, /syntax-error/);
  assert.match(output, /conditional-return/);
  assert.equal(output.includes("TOP_SECRET"), false);
});

test("known federation constructors are recognized from static CommonJS imports", () => {
  for (const declaration of [
    "const {ModuleFederationPlugin}=require('@module-federation/enhanced/webpack');",
    "const {ModuleFederationPlugin}=require('webpack').container;",
    "const {ModuleFederationPlugin: MF}=require('@module-federation/enhanced/webpack');",
  ]) {
    const constructor = declaration.includes(": MF") ? "MF" : "ModuleFederationPlugin";
    const source = `${declaration} module.exports={devServer:{port:3001},plugins:[new ${constructor}({name:'app',manifest:true})]};`;
    const app = discoverSource(source, path.resolve("webpack.config.cjs"), {});
    assert.equal(app?.name, "app", declaration);
    assert.equal(app.port, 3001);
    assert.equal(app.manifest, true);
  }
});

test("default export aliases select the complete configuration", () => {
  const source =
    "const config={server:{port:3001},plugins:[pluginModuleFederation({name:'app'})]}; export {config as default};";
  const app = discoverSource(source, path.resolve("rsbuild.config.ts"), {});
  assert.equal(app?.name, "app");
  assert.equal(app.port, 3001);
});

test("default re-exports resolve the config and record its dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-default-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const helper = path.join(root, "config.ts");
  fs.writeFileSync(
    helper,
    "export const config={server:{port:3001},plugins:[pluginModuleFederation({name:'app'})]};",
  );
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    "export {config as default} from './config';",
  );
  const dependencies = new Set<string>();
  const app = readAppFolder(root, "development", "app", dependencies);
  assert.equal(app?.name, "app");
  assert.equal(app.port, 3001);
  assert.equal(app.configFile, helper);
  assert.ok(dependencies.has(helper));
});

test("only plugins retained by the final configuration select the application", () => {
  for (const source of [
    "export default {plugins:[pluginModuleFederation({name:'decoy'})],plugins:[pluginModuleFederation({name:'app'})]};",
    "const base={plugins:[pluginModuleFederation({name:'decoy'})]}; export default {...base,plugins:[pluginModuleFederation({name:'app'})]};",
    "const base={plugins:[pluginModuleFederation({name:'decoy'})]}; export default {...base,plugins:[]};",
  ]) {
    const app = discoverSource(source, path.resolve("rsbuild.config.ts"), {});
    assert.equal(app?.name ?? null, source.includes("plugins:[]") ? null : "app", source);
  }
});

test("unresolved or absent final plugins never reuse discarded calls", () => {
  for (const plugins of ["undefined", "null", "false", "unknown()"])
    assert.equal(
      discoverSource(
        `export default {plugins:[pluginModuleFederation({name:'before'})],plugins:${plugins}};`,
        path.resolve("rsbuild.config.ts"),
        {},
      ),
      null,
      plugins,
    );
  for (const source of [
    "export default {other:pluginModuleFederation({name:'before'})};",
    "const discarded={other:pluginModuleFederation({name:'before'})};",
    "export default {...unknown(),other:pluginModuleFederation({name:'before'})};",
  ])
    assert.equal(discoverSource(source, path.resolve("rsbuild.config.ts"), {}), null, source);
  assert.equal(
    discoverSource(
      "pluginModuleFederation({name:'app'}); export default {server:{port:3001}};",
      path.resolve("rsbuild.config.ts"),
      {},
    )?.name,
    "app",
  );
});

test("named helper exports keep the same mutation guards as local bindings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-export-writes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const helper = path.join(root, "options.ts");
  const config = path.join(root, "rsbuild.config.ts");
  for (const [source, argument, expected] of [
    ["export const options={name:'app'};", "options", "app"],
    ["export function options(){return {name:'app'}}", "options()", "app"],
    ["export const options={name:'before'}; options.name='after';", "options", null],
    ["export let options={name:'before'}; options={name:'after'};", "options", null],
    [
      "export function options(){return {name:'before'}} options=()=>({name:'after'});",
      "options()",
      null,
    ],
    ["const options={name:'before'}; options.name='after'; export {options};", "options", null],
  ] as const) {
    fs.writeFileSync(helper, source);
    for (const declaration of [
      "import {options} from './options';",
      "import {options} from './barrel';",
    ]) {
      fs.writeFileSync(path.join(root, "barrel.ts"), "export {options} from './options';");
      fs.writeFileSync(
        config,
        `${declaration} export default pluginModuleFederation(${argument});`,
      );
      assert.equal(readAppFolder(root, "development")?.name ?? null, expected, source);
    }
  }
  fs.writeFileSync(helper, "export const options={name:'before'};");
  fs.writeFileSync(
    config,
    "import * as ns from './options'; ns.options.name='after'; export default pluginModuleFederation(ns.options);",
  );
  assert.equal(readAppFolder(root, "development"), null);
  for (const exported of [
    "export {options}",
    "export {options as default}",
    "export default options",
  ]) {
    fs.writeFileSync(
      path.join(root, "barrel.ts"),
      `import {options} from './options'; options.name='after'; ${exported};`,
    );
    const declaration =
      exported === "export {options}"
        ? "import {options} from './barrel';"
        : "import options from './barrel';";
    fs.writeFileSync(config, `${declaration} export default pluginModuleFederation(options);`);
    assert.equal(readAppFolder(root, "development"), null, exported);
  }
});

test("writes through aliases cannot publish an obsolete options object", () => {
  for (const prelude of [
    "const alias=options; alias.name='after';",
    "const alias=options; const next=alias; next.name='after';",
    "const alias=options as const; alias.name='after';",
    "const alias=options; delete alias.name;",
    "const alias=options; alias.name++;",
    "const {remotes}=options; remotes.widget='after@http://localhost:3002/mf-manifest.json';",
  ])
    assert.equal(
      discoverSource(
        `const options={name:'before',remotes:{widget:'before@http://localhost:3001/mf-manifest.json'}}; ${prelude} export default pluginModuleFederation(options);`,
        path.resolve("rsbuild.config.ts"),
        {},
      ),
      null,
      prelude,
    );
  assert.equal(
    discoverSource(
      "const make=x=>{const alias=x; alias.name='after'; return x}; export default pluginModuleFederation(make({name:'before'}));",
      path.resolve("rsbuild.config.ts"),
      {},
    ),
    null,
  );
  assert.equal(
    discoverSource(
      "const options={name:'app'}; let alias=options; alias={name:'other'}; export default pluginModuleFederation(options);",
      path.resolve("rsbuild.config.ts"),
      {},
    )?.name,
    "app",
  );
});

test("object methods with static keys obey last-wins without evaluating getters", () => {
  for (const method of [
    "get name(){return 'after'}",
    "get 'name'(){return 'after'}",
    "get ['name'](){return 'after'}",
    "get ['na'+'me'](){return 'after'}",
    "['name'](){return 'after'}",
    "get [unknown()](){return 'after'}",
  ])
    assert.equal(
      discoverSource(
        `export default pluginModuleFederation({name:'before',${method}});`,
        path.resolve("rsbuild.config.ts"),
        {},
      ),
      null,
      method,
    );
  assert.equal(
    discoverSource(
      "export default pluginModuleFederation({get ['name'](){throw new Error('not executed')},name:'app'});",
      path.resolve("rsbuild.config.ts"),
      {},
    )?.name,
    "app",
  );
});

test("named CommonJS imports use the final object, including overrides and spreads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-cjs-final-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    "import {options} from './options.cjs'; export default pluginModuleFederation(options);",
  );
  const helper = path.join(root, "options.cjs");
  for (const [source, expected] of [
    ["module.exports={options:{name:'before'},options:{name:'app'}};", "app"],
    ["module.exports={options:{name:'before'},...{options:{name:'app'}}};", "app"],
    ["module.exports={options:{name:'before'},...unknown()};", null],
    ["module.exports={['options']:{name:'app'}};", "app"],
    ["const result={options:{name:'app'}}; module.exports=result;", "app"],
    ["exports.options={name:'before'}; module.exports={options:{name:'app'}};", "app"],
    ["exports.options={name:'before'}; module.exports={};", null],
    ["module.exports={options:{name:'before'}}; exports.options={name:'after'};", null],
    ["module.exports={options:{name:'before'},get ['options'](){return {name:'after'}}};", null],
    ["const options={name:'before'}; options.name='after'; module.exports={options};", null],
    [
      "module.exports={options:{name:'before'}}; const alias=module.exports.options; alias.name='after';",
      null,
    ],
    [
      "module.exports={options:{name:'before'}}; const alias=module.exports?.options; alias.name='after';",
      null,
    ],
    [
      "module.exports={options:{name:'before'}}; const alias=module?.exports?.options; alias.name='after';",
      null,
    ],
    ["exports.options={name:'before'}; const alias=exports.options; alias.name='after';", null],
    ["exports.options={name:'before'}; exports={}; exports.options={name:'after'};", null],
    [
      "module.exports={options:{name:'before'}}; const alias=module.exports; const next=alias.options; delete next.name;",
      null,
    ],
    [
      "module.exports={options:{name:'before'}}; const {options}=module.exports; options.name++;",
      null,
    ],
    ["exports.options={name:'before'}; const alias=exports; alias.options.name='after';", null],
    [
      "module.exports={options:{name:'app'}}; const alias=module.exports.options; console.log(alias.name);",
      "app",
    ],
    [
      "module.exports={options:{name:'app'}}; let alias=module.exports.options; alias={name:'other'};",
      "app",
    ],
  ] as const) {
    fs.writeFileSync(helper, source);
    assert.equal(readAppFolder(root, "development")?.name ?? null, expected, source);
  }
});

test("unused or shadowed CommonJS assignments cannot replace the selected export", () => {
  for (const tail of [
    "function unused(module) {module.exports={name:'decoy'};}",
    "function unused() {module.exports={name:'decoy'};}",
    "const module={}; module.exports={name:'decoy'};",
  ]) {
    const source = `export default {name:'app'}; ${tail}`;
    assert.equal(discoverSource(source, path.resolve("rsbuild.config.ts"), {})?.name, "app", tail);
  }
});

test("conditional CommonJS writes invalidate a prior unconditional export", () => {
  for (const write of [
    "if (process.env.MODE==='dev') module.exports={name:'dev'}; else module.exports={name:'prod'};",
    "if (process.env.MODE==='dev') module.exports.name='dev';",
    "for (const value of values) module.exports={name:value};",
    "if (process.env.MODE==='dev') delete module.exports.name;",
    "module.exports.name++;",
  ]) {
    const source = `module.exports={name:'before'}; ${write}`;
    assert.equal(discoverSource(source, path.resolve("webpack.config.cjs"), {}), null, write);
  }
});

test("named CommonJS exports ignore nested bindings and reject conditional mutations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-cjs-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    "import {options} from './options.cjs'; export default pluginModuleFederation(options);",
  );
  const helper = path.join(root, "options.cjs");
  fs.writeFileSync(
    helper,
    "exports.options={name:'app'}; function unused(exports) {exports.options={name:'decoy'};}",
  );
  assert.equal(readAppFolder(root, "development", "app")?.name, "app");
  fs.writeFileSync(
    helper,
    "exports.options={name:'app'}; if (process.env.MODE==='dev') exports.options={name:'dev'};",
  );
  assert.equal(readAppFolder(root, "development", "app"), null);
});

test("writes through helper parameters and delete never publish the former initializer", () => {
  for (const source of [
    "const make=x=>{x.name='changed';return x}; export default pluginModuleFederation(make({name:'before'}));",
    "const make=x=>{x={name:'changed'};return x}; export default pluginModuleFederation(make({name:'before'}));",
    "const options={name:'before'}; delete options.name; export default pluginModuleFederation(options);",
  ])
    assert.equal(discoverSource(source, path.resolve("rsbuild.config.ts"), {}), null, source);
});

test("unknown DTS values do not enable generation or consumption defaults", () => {
  const source =
    "export default pluginModuleFederation({name:'app',dts:{generateTypes:unknown(),consumeTypes:unknown()}});";
  const app = discoverSource(source, path.resolve("rsbuild.config.ts"), {});
  assert.equal(app?.name, "app");
  assert.equal(app.generateTypes, false);
  assert.equal(app.consumeTypes, false);
  const defaults = discoverSource(
    "export default pluginModuleFederation({name:'app',dts:{}});",
    path.resolve("rsbuild.config.ts"),
    {},
  );
  assert.equal(defaults?.generateTypes, true);
  assert.equal(defaults.consumeTypes, true);
});

test("an unreadable helper is safely skipped while other apps remain discoverable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-babel-unreadable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "module-federation.config.ts"), "export default {name:'kept'};");
  fs.writeFileSync(
    path.join(root, "rsbuild.config.ts"),
    "import options from './options'; export default pluginModuleFederation(options);",
  );
  const helper = path.join(root, "options.ts");
  fs.writeFileSync(helper, "export default {name:'unreadable'};");
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === helper)
      throw Object.assign(new Error("TOP_SECRET source and env must not be logged"), {
        code: "EACCES",
      });
    return original(...args);
  });
  const messages: string[] = [];
  const log = createLogger({ enabled: () => true, write: (_level, text) => messages.push(text) });
  assert.deepEqual(Object.keys(scanWorkspace(root, { log })), ["kept"]);
  const output = messages.join("\n");
  assert.match(output, /unreadable-helper/);
  assert.match(output, /EACCES/);
  assert.equal(output.includes("TOP_SECRET"), false);
  const dependencies = new Set<string>();
  assert.equal(readAppFolder(root, "development", "kept", dependencies)?.name, "kept");
  assert.ok(dependencies.has(helper));
});

test("discovery rejects return and break outside their permitted contexts", () => {
  const file = path.resolve("rsbuild.config.js");
  for (const source of [
    "return pluginModuleFederation({name:'app'});",
    "break; pluginModuleFederation({name:'app'});",
  ])
    assert.equal(discoverSource(source, file, {}), null, source);
  assert.equal(
    discoverSource(
      "function unused(){return 1;} switch(true){case true:break;} pluginModuleFederation({name:'app'});",
      file,
      {},
    )?.name,
    "app",
  );
});
