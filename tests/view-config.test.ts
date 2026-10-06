import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
  contributes: {
    commands?: { command: string; title: string; icon?: string }[];
    viewsWelcome?: { view: string; contents: string }[];
    menus?: {
      commandPalette?: { command: string; when?: string }[];
      "view/title"?: { command: string; when?: string; group?: string }[];
      "view/item/context"?: { command: string; when?: string; group?: string }[];
    };
  };
};
const en = JSON.parse(
  readFileSync(new URL("../package.nls.json", import.meta.url), "utf8"),
) as Record<string, string>;
const ru = JSON.parse(
  readFileSync(new URL("../package.nls.ru.json", import.meta.url), "utf8"),
) as Record<string, string>;

test("the extension bundle loads without project dependencies or extra implementation files", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mf-extension-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "extension.cjs");
  const mainFields = pkg.scripts?.compile.match(/--main-fields=(\S+)/)?.[1].split(",");
  buildSync({
    entryPoints: [fileURLToPath(new URL("../src/app/extension.ts", import.meta.url))],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    mainFields,
    alias: Object.fromEntries(
      [...(pkg.scripts?.compile ?? "").matchAll(/--alias:([^=\s]+)=(\S+)/g)].map(
        ([, name, replacement]) => [name, replacement],
      ),
    ),
  });
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'const Module=require("node:module"); const load=Module._load; Module._load=function(name,parent,isMain){return name==="vscode"?{EventEmitter:class {}}:load.call(this,name,parent,isMain)}; require(process.argv[1]);',
      file,
    ],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

function welcomeContents(): string {
  const entry = pkg.contributes.viewsWelcome?.find((item) => item.view === "mf-dashboard");
  assert.ok(entry, "viewsWelcome for mf-dashboard");
  return entry.contents;
}

test("row navigation commands stay out of the command palette", () => {
  for (const name of ["openConfig", "openProducerConfig", "revealTypes", "openManifest"]) {
    assert.equal(
      pkg.contributes.menus?.commandPalette?.find((item) => item.command === `mf-dashboard.${name}`)
        ?.when,
      "false",
    );
  }
});

test("viewsWelcome localizes the entire contents with a discover link", () => {
  const contents = welcomeContents();
  assert.match(contents, /^%[^%]+%$/);
  const key = contents.slice(1, -1);
  assert.equal(
    en[key],
    "No Module Federation configs found\n[Find microfrontends](command:mf-dashboard.discover)",
  );
  assert.equal(
    ru[key],
    "Конфиги Module Federation не найдены\n[Найти микрофронты](command:mf-dashboard.discover)",
  );
});

test("refresh and discover are declared commands", () => {
  const commands = new Map(
    (pkg.contributes.commands ?? []).map((command) => [command.command, command.title]),
  );
  assert.equal(commands.get("mf-dashboard.refresh"), "%command.refresh%");
  assert.equal(commands.get("mf-dashboard.discover"), "%command.discover%");
  assert.equal(en["command.refresh"], "Refresh");
  assert.equal(ru["command.refresh"], "Обновить");
  assert.equal(en["command.discover"], "Find microfrontends");
  assert.equal(ru["command.discover"], "Найти микрофронты");
});

test("refresh is the view title action", () => {
  const title = pkg.contributes.menus?.["view/title"] ?? [];
  assert.deepEqual(
    title.find((item) => item.command === "mf-dashboard.refresh"),
    {
      command: "mf-dashboard.refresh",
      when: "view == mf-dashboard",
      group: "navigation",
    },
  );
});

test("a package and a launch compile the extension before the host starts", () => {
  assert.equal(pkg.scripts?.["vscode:prepublish"], "npm run compile");
  const launch = JSON.parse(
    readFileSync(new URL("../.vscode/launch.json", import.meta.url), "utf8"),
  ) as {
    configurations?: { type?: string; preLaunchTask?: string; args?: string[] }[];
  };
  const host = launch.configurations?.find((item) => item.type === "extensionHost");
  assert.equal(host?.preLaunchTask, "npm: compile");
  assert.ok(host?.args?.some((arg) => arg.includes("--extensionDevelopmentPath")));
  const ignore = readFileSync(new URL("../.vscodeignore", import.meta.url), "utf8");
  assert.equal(
    ignore.split("\n").some((line) => line.trim() === "dist" || line.trim() === "dist/"),
    false,
  );
});

test("start, rebuild, and refetch are inline on silent, stale, and unfetched", () => {
  const commands = new Map(
    (pkg.contributes.commands ?? []).map((command) => [command.command, command.title]),
  );
  assert.equal(commands.get("mf-dashboard.start"), "%command.start%");
  assert.equal(commands.get("mf-dashboard.rebuildTypes"), "%command.rebuildTypes%");
  assert.equal(commands.get("mf-dashboard.refetchTypes"), "%command.refetchTypes%");
  assert.equal(en["command.start"], "Start");
  assert.equal(ru["command.start"], "Запустить");
  assert.equal(en["command.rebuildTypes"], "Rebuild types");
  assert.equal(ru["command.rebuildTypes"], "Сгенерировать типы");
  assert.equal(en["command.refetchTypes"], "Fetch @mf-types");
  assert.equal(ru["command.refetchTypes"], "Загрузить @mf-types");

  const inline = pkg.contributes.menus?.["view/item/context"] ?? [];
  const byCommand = new Map(inline.map((item) => [item.command, item]));
  assert.deepEqual(byCommand.get("mf-dashboard.start"), {
    command: "mf-dashboard.start",
    when: "view == mf-dashboard && viewItem =~ /^silent($| )/",
    group: "inline",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.rebuildTypes"), {
    command: "mf-dashboard.rebuildTypes",
    when: "view == mf-dashboard && viewItem =~ /^stale($| )/",
    group: "inline",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.refetchTypes"), {
    command: "mf-dashboard.refetchTypes",
    when: "view == mf-dashboard && viewItem =~ /^unfetched($| )/",
    group: "inline",
  });
});

test("row actions use navigation menus with token boundaries and no inline icons", () => {
  const menus = pkg.contributes.menus?.["view/item/context"] ?? [];
  for (const [name, token] of [
    ["openConfig", "config"],
    ["openProducerConfig", "producer"],
    ["revealTypes", "types"],
    ["openManifest", "manifest"],
  ]) {
    const command = `mf-dashboard.${name}`;
    assert.deepEqual(
      menus.filter((item) => item.command === command),
      [
        {
          command,
          when: `view == mf-dashboard && viewItem =~ /(^| )${token}($| )/`,
          group: "navigation",
        },
      ],
    );
    const declared = pkg.contributes.commands?.find((item) => item.command === command);
    assert.ok(declared);
    assert.equal(declared.icon, undefined);
    const key = declared.title.slice(1, -1);
    assert.ok(en[key]);
    assert.ok(ru[key]);
  }
});

test("Show Logs is localized and available in the palette", () => {
  const declared = pkg.contributes.commands?.find(
    (item) => item.command === "mf-dashboard.showLogs",
  );
  assert.equal(declared?.title, "%command.showLogs%");
  assert.ok(en["command.showLogs"]);
  assert.ok(ru["command.showLogs"]);
  assert.equal(
    pkg.contributes.menus?.commandPalette?.some(
      (item) => item.command === "mf-dashboard.showLogs" && item.when === "false",
    ),
    false,
  );
});
