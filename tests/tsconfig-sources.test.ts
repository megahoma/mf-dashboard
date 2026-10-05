import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  sourceIdentity,
  sourceContains,
  sourceSnapshot,
} from "../src/entities/federated-types/sources.ts";

const cases: [string, Record<string, unknown> | string][] = [
  ["empty JSONC", ""],
  ["comments only", "// An empty config uses default includes\n"],
  ["explicit files and empty include", { files: ["src/a.ts"], include: [] }],
  ["files only", { files: ["src/a.ts"] }],
  ["files and includes are combined", { files: ["src/a.ts"], include: ["src/nested/"] }],
  ["empty files", { files: [] }],
  [
    "output outside the app does not hide explicit inputs",
    { compilerOptions: { outDir: ".." }, files: ["src/a.ts"], include: [] },
  ],
  ["explicit files override excludes", { files: ["src/a.ts"], exclude: ["src/a.ts"], include: [] }],
  ["no inputs", { include: [] }],
  ["default includes", {}],
  ["empty include spec", { include: [""] }],
  ["empty exclude spec", { exclude: [""] }],
  ["current directory exclude", { exclude: ["."] }],
  ["relative base", { extends: "./configs/base.json" }],
  ["extends array", { extends: ["./configs/base.json", "./configs/second.json"] }],
  ["package extends", { extends: "@fixture/config" }],
  ["wildcard excludes", { include: ["src/**/*.ts"], exclude: ["src/nested/*"] }],
  ["trailing slash include", { include: ["src/"] }],
  ["trailing slash exclude", { include: ["src/**/*.ts"], exclude: ["src/nested/"] }],
  [
    "trailing slash exclude with parent segments",
    { include: ["src/"], exclude: ["configs/../src/"] },
  ],
  ["inherited trailing slashes", { extends: "./configs/slash.json" }],
  ["directory basename with a dot", { include: ["src/foo.bar/"] }],
  ["TS has priority over a same-name TSX", { include: ["src/**/*"] }],
  ["TSX is retained when TS is outside include", { include: ["src/**/*.tsx"] }],
  [
    "explicit TSX is retained alongside a same-name TS",
    { files: ["src/a.tsx"], include: ["src/**/*"] },
  ],
  ["literal brackets", { include: ["src/[literal]/**/*.ts"] }],
  ["literal parentheses", { include: ["src/(literal)/**/*.ts"] }],
  ["question wildcard in a directory", { include: ["src/?ne/*.ts"] }],
  ["question wildcard inside a directory name", { include: ["src/o?e/*.ts"] }],
  ["question wildcard in a file name", { include: ["src/one/?.ts"] }],
  ["question wildcard in an exclude", { include: ["src/**/*.ts"], exclude: ["src/?ne"] }],
];
for (const [title, config] of cases) {
  test(`source selection matches TS7: ${title}`, (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-tsconfig-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    for (const file of [
      "src/a.ts",
      "src/a.tsx",
      "src/b.ts",
      "src/nested/c.ts",
      "src/foo.bar/a.ts",
      "src/[literal]/a.ts",
      "src/(literal)/a.ts",
      "src/one/a.ts",
      "src/one/b.ts",
      "emitted/generated.ts",
    ])
      write(file, "export const value=1;");
    write(
      "configs/base.json",
      '// JSONC\n{"include":["../src/a.ts"],"compilerOptions":{"outDir":"../emitted"},}',
    );
    write(
      "configs/second.json",
      JSON.stringify({ include: ["../src/b.ts"], compilerOptions: { outDir: "../emitted" } }),
    );
    write(
      "configs/slash.json",
      JSON.stringify({ include: ["../src/"], exclude: ["../src/nested/"] }),
    );
    write(
      "node_modules/@fixture/config/package.json",
      JSON.stringify({ name: "@fixture/config", tsconfig: "base.json" }),
    );
    write(
      "node_modules/@fixture/config/base.json",
      JSON.stringify({
        include: ["../../../src/a.ts"],
        compilerOptions: { outDir: "../../../emitted" },
      }),
    );
    const file = path.join(root, "tsconfig.json");
    write("tsconfig.json", typeof config === "string" ? config : JSON.stringify(config));
    const cli = path.resolve("node_modules/typescript/bin/tsc");
    const result = spawnSync(process.execPath, [cli, "-p", file, "--noLib", "--listFilesOnly"], {
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    const expected = result.stdout
      .split(/\r?\n/)
      .filter((name) => path.isAbsolute(name) && /\.tsx?$/.test(name))
      .map((name) => path.relative(root, name).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(
      sourceSnapshot(root, null, "@mf-types")
        .files.map((file) => file.name)
        .sort(),
      expected,
      result.stdout,
    );
    for (const name of expected)
      assert.equal(sourceContains(root, null, "@mf-types", path.join(root, name)), true);
  });
}

test("a types folder outside the app does not hide its sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-types-outside-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "source");
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ files: ["a.ts"], include: [] }),
  );
  for (const typesFolder of ["..", path.dirname(fs.realpathSync(root))])
    assert.deepEqual(sourceIdentity(root, null, typesFolder).names, ["a.ts"]);
});

test("glob metacharacters in the app folder are literal paths", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mf-literal-path-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // Windows forbids these characters in folder names.
  if (process.platform === "win32") return;
  for (const name of ["with*star", "with?question", "with[literal]", "with(parentheses)"]) {
    const root = path.join(parent, name);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.ts"), "source");
    for (const config of [{}, { include: ["src/**/*"] }]) {
      fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify(config));
      assert.deepEqual(sourceIdentity(root, null, "@mf-types").names, ["src/a.ts"], name);
    }
  }
});

test("malformed root and inherited JSONC never confirm a partial source set", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-jsonc-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "source");
  const leaf = path.join(root, "tsconfig.json");
  const parent = path.join(root, "base.json");
  for (const malformed of ['{"include": broken}', '{"include":["*.ts"', "[]", "null"]) {
    fs.writeFileSync(leaf, malformed);
    assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/, malformed);
    fs.writeFileSync(parent, malformed);
    fs.writeFileSync(leaf, JSON.stringify({ extends: "./base.json", include: ["a.ts"] }));
    assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/, malformed);
  }
  for (const field of ["files", "include", "exclude"])
    for (const value of [null, true, [1]]) {
      fs.writeFileSync(leaf, JSON.stringify({ [field]: value }));
      assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/);
    }
});

test("a malformed package config is rejected even when its include is overridden", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-package-jsonc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFolder = path.join(root, "node_modules/@fixture/config");
  fs.mkdirSync(packageFolder, { recursive: true });
  fs.writeFileSync(path.join(root, "a.ts"), "source");
  fs.writeFileSync(
    path.join(packageFolder, "package.json"),
    JSON.stringify({ name: "@fixture/config", tsconfig: "base.json" }),
  );
  fs.writeFileSync(path.join(packageFolder, "base.json"), '{"include": broken}');
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: "@fixture/config", include: ["a.ts"] }),
  );
  assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/);
});

test("a missing nested tsconfig falls back to the app folder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-missing-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "source");
  assert.deepEqual(sourceIdentity(root, "missing/tsconfig.json", "@mf-types").names, ["a.ts"]);
});

test("glob scans do not read excluded folders or folders outside include", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-glob-pruning-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ["src", "excluded", "unrelated"]) {
    fs.mkdirSync(path.join(root, folder));
    fs.writeFileSync(path.join(root, folder, "a.ts"), "source");
  }
  const original = fs.readdirSync;
  const list = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (["excluded", "unrelated"].includes(path.relative(root, String(args[0]))))
      throw Object.assign(new Error("unreadable excluded folder"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  });
  for (const config of [
    { include: ["src/**/*.ts"], exclude: ["excluded"] },
    { include: ["**/*.ts"], exclude: ["excluded", "unrelated"] },
    { include: ["**/*.ts"], exclude: ["excl*", "unrelated/"] },
  ]) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify(config));
    assert.deepEqual(sourceIdentity(root, null, "@mf-types").names, ["src/a.ts"]);
  }
  assert.equal(
    list.mock.calls.some((call) =>
      ["excluded", "unrelated"].includes(path.relative(root, String(call.arguments[0]))),
    ),
    false,
  );
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config/tsconfig.json"),
    JSON.stringify({ include: ["../**/*.ts"], exclude: ["../excl*", "../unrelated"] }),
  );
  assert.deepEqual(sourceIdentity(root, "config/tsconfig.json", "@mf-types").names, ["src/a.ts"]);
});

test("implicit package folders are pruned unless an include names them explicitly", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-glob-implicit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of [
    "src",
    "bower_components/pkg",
    "jspm_packages/pkg",
    "src/bower_components/pkg",
  ]) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, "a.ts"), "export const value=1;");
  }
  const original = fs.readdirSync;
  let blocked = true;
  const read = t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (
      blocked &&
      path
        .relative(root, String(args[0]))
        .split(path.sep)
        .some((part) => ["bower_components", "jspm_packages"].includes(part))
    )
      throw Object.assign(new Error("unreadable implicit folder"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  });
  const config = path.join(root, "tsconfig.json");
  for (const include of [undefined, ["**/*.ts"], ["src/**/*.ts"]]) {
    fs.writeFileSync(config, JSON.stringify({ include }));
    assert.deepEqual(sourceIdentity(root, null, "@mf-types").names, ["src/a.ts"]);
  }
  assert.equal(
    read.mock.calls.some((call) =>
      path
        .relative(root, String(call.arguments[0]))
        .split(path.sep)
        .some((part) => ["bower_components", "jspm_packages"].includes(part)),
    ),
    false,
  );
  blocked = false;
  fs.writeFileSync(
    config,
    JSON.stringify({
      include: [
        "bower_components/pkg/**/*.ts",
        "src/**/bower_components/pkg/**/*.ts",
        "jspm_packages/pkg/**/*.ts",
      ],
    }),
  );
  assert.deepEqual(sourceIdentity(root, null, "@mf-types").names, [
    "bower_components/pkg/a.ts",
    "jspm_packages/pkg/a.ts",
    "src/bower_components/pkg/a.ts",
  ]);
  fs.writeFileSync(path.join(root, "bower_components/tsconfig.json"), "{}");
  assert.deepEqual(sourceIdentity(root, "bower_components/tsconfig.json", "@mf-types").names, [
    "bower_components/pkg/a.ts",
  ]);
  blocked = true;
  assert.throws(
    () => sourceIdentity(root, null, "@mf-types"),
    (error) => error instanceof Error && "code" in error && error.code === "EACCES",
  );
});

test("invalid original selection rules are rejected before normalized library results are used", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-config-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "source");
  const leaf = path.join(root, "tsconfig.json");
  const parent = path.join(root, "base.json");
  for (const invalid of [
    { compilerOptions: false },
    { compilerOptions: { outDir: 0 } },
    { compilerOptions: { declarationDir: false } },
    { extends: false },
    { include: ["src/**"] },
    { include: ["src/**/../a.ts"] },
    { exclude: ["src/**/../a.ts"] },
    { exclude: null },
  ]) {
    fs.writeFileSync(leaf, JSON.stringify(invalid));
    assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/);
    fs.writeFileSync(parent, JSON.stringify(invalid));
    fs.writeFileSync(
      leaf,
      JSON.stringify({ extends: "./base.json", include: ["src/a.ts"], exclude: [] }),
    );
    assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/);
  }
});

test("nested config includes cannot start scanning symlinks or excluded directories", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-source-start-")));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mf-source-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  for (const dir of ["config", "src", "node_modules/pkg/nested"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(outside, "nested"));
  fs.writeFileSync(path.join(outside, "nested/secret.ts"), "outside");
  fs.writeFileSync(path.join(root, "node_modules/pkg/nested/ignored.ts"), "ignored");
  fs.writeFileSync(path.join(root, "src/a.ts"), "own source");
  fs.symlinkSync(outside, path.join(root, "link"), "junction");
  fs.writeFileSync(
    path.join(root, "config/tsconfig.json"),
    JSON.stringify({
      include: [
        "../link/**/*.ts",
        "../node_modules/pkg/**/*.ts",
        "../src/**/*.ts",
        "../missing/**/*.ts",
      ],
    }),
  );
  const read = t.mock.method(fs, "readdirSync");
  assert.deepEqual(sourceIdentity(root, "config/tsconfig.json", "@mf-types").names, ["src/a.ts"]);
  const scanned = read.mock.calls.map((call) => path.relative(root, String(call.arguments[0])));
  for (const forbidden of ["link", "node_modules", "missing"])
    assert.equal(
      scanned.some((name) => name === forbidden || name.startsWith(`${forbidden}${path.sep}`)),
      false,
      forbidden,
    );
});

test("an unreadable starting directory fails instead of confirming a partial source set", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mf-source-access-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "source");
  fs.writeFileSync(
    path.join(root, "config/tsconfig.json"),
    JSON.stringify({ include: ["../src/**/*.ts"] }),
  );
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === path.join(root, "src"))
      throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  });
  assert.throws(
    () => sourceIdentity(root, "config/tsconfig.json", "@mf-types"),
    (error) => error instanceof Error && "code" in error && error.code === "EACCES",
  );
});

test("an explicit source edit changes identity and inherited config changes invalidate selection", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mf-tsconfig-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "one");
  fs.writeFileSync(path.join(root, "b.ts"), "two");
  const base = path.join(root, "base.json");
  fs.writeFileSync(base, JSON.stringify({ files: ["a.ts"], include: [] }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
  const first = sourceIdentity(root, null, "@mf-types");
  assert.deepEqual(first.names, ["a.ts"]);
  fs.writeFileSync(path.join(root, "a.ts"), "changed source");
  assert.notEqual(sourceIdentity(root, null, "@mf-types").fingerprint, first.fingerprint);
  fs.writeFileSync(base, JSON.stringify({ files: ["b.ts"], include: [] }));
  assert.deepEqual(sourceIdentity(root, null, "@mf-types").names, ["b.ts"]);
  fs.writeFileSync(base, '{"include": broken}');
  assert.throws(() => sourceIdentity(root, null, "@mf-types"), /Invalid tsconfig/);
});
