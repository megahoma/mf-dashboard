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
    commands?: { command: string; title: string; icon?: string; enablement?: string }[];
    submenus?: { id: string; label: string }[];
    views?: Record<
      string,
      { id: string; name: string; type?: string; visibility?: string; when?: string }[]
    >;
    menus?: {
      commandPalette?: { command: string; when?: string }[];
      "view/title"?: { command?: string; submenu?: string; when?: string; group?: string }[];
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

test("commands requiring a row stay out of the command palette", () => {
  for (const name of [
    "openConfig",
    "openProducerConfig",
    "revealTypes",
    "openManifest",
    "start",
    "rebuildTypes",
    "rebuildAppTypes",
    "refetchTypes",
  ]) {
    assert.equal(
      pkg.contributes.menus?.commandPalette?.find((item) => item.command === `mf-dashboard.${name}`)
        ?.when,
      "false",
    );
  }
});

test("only the first-search screen uses a webview in place of the microfrontend tree", () => {
  const views = pkg.contributes.views?.["mf-dashboard"] ?? [];
  const welcome = views.find(({ id }) => id === "mf-dashboard.welcome");
  const tree = views.find(({ id }) => id === "mf-dashboard");
  assert.equal(welcome?.type, "webview");
  assert.equal(welcome?.when, "!mf-dashboard.searching && mf-dashboard.welcomeVisible");
  assert.equal(tree?.type, undefined);
  assert.equal(tree?.when, "!mf-dashboard.searching && !mf-dashboard.welcomeVisible");
});

test("details have a localized title whenever the dashboard tree is visible", () => {
  const views = pkg.contributes.views?.["mf-dashboard"] ?? [];
  for (const [suffix, name, condition] of [
    [
      "",
      "%view.details%",
      "config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
    ],
    [".en", "Details", "config.mf-dashboard.language == en"],
    [".ru", "Подробности", "config.mf-dashboard.language == ru"],
  ]) {
    const view = views.find((entry) => entry.id === `mf-dashboard.details${suffix}`);
    assert.equal(view?.name, name);
    assert.equal(view?.type, "webview");
    assert.equal(
      view?.when,
      `!mf-dashboard.searching && !mf-dashboard.welcomeVisible && ${condition}`,
    );
    assert.equal(view?.visibility, "collapsed");
  }
  const types = views.find((entry) => entry.id === "mf-dashboard.typesBuild");
  assert.equal(types?.when, "mf-dashboard.appsVisible");
  assert.equal(types?.visibility, "collapsed");
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

test("refresh and the localized workspace types update are available in the view title", () => {
  const title = pkg.contributes.menus?.["view/title"] ?? [];
  assert.deepEqual(
    title.find((item) => item.command === "mf-dashboard.refresh"),
    {
      command: "mf-dashboard.refresh",
      when: "view == mf-dashboard && !mf-dashboard.discovering && config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
      group: "navigation",
    },
  );
  for (const name of ["discover", "useFlat", "useTree"]) {
    const action = title.find((item) => item.command === `mf-dashboard.${name}`);
    assert.match(action?.when ?? "", /^view == mf-dashboard && !mf-dashboard\.discovering/);
    assert.doesNotMatch(action?.when ?? "", /mf-dashboard\.appsVisible/);
  }
  const update = title.find((item) => item.command === "mf-dashboard.rebuildAllTypes");
  assert.equal(
    update?.when,
    "view == mf-dashboard && mf-dashboard.canUpdateTypes && config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
  );
  assert.match(update?.group ?? "", /^navigation/);
  const command = pkg.contributes.commands?.find((item) => item.command === update?.command);
  assert.equal(command?.title, "%command.rebuildAllTypes%");
  assert.equal(command?.enablement, "isWorkspaceTrusted && mf-dashboard.canUpdateTypes");
  assert.equal(en["command.rebuildAllTypes"], "Update all @mf-types");
  assert.equal(ru["command.rebuildAllTypes"], "Обновить все @mf-types");
  const items = pkg.contributes.menus?.["view/item/context"] ?? [];
  const declared = new Map(pkg.contributes.commands?.map((entry) => [entry.command, entry]));
  for (const name of ["refresh", "discover", "useFlat", "useTree", "rebuildAllTypes", "start"]) {
    const command = `mf-dashboard.${name}`;
    const menu = name === "start" ? items : title;
    const original = menu.find((entry) => entry.command === command);
    const condition = original?.when?.replace(
      / && config\.mf-dashboard\.language != en && config\.mf-dashboard\.language != ru$/,
      "",
    );
    assert.ok(condition, name);
    for (const [locale, alphabet] of [
      ["en", /^[A-Z]/],
      ["ru", /^[А-Я]/],
    ] as const) {
      const id = `${command}.${locale}`;
      assert.deepEqual(
        menu.find((entry) => entry.command === id),
        {
          command: id,
          when: `${condition} && config.mf-dashboard.language == ${locale}`,
          group: original?.group,
        },
      );
      assert.match(declared.get(id)?.title ?? "", alphabet);
      assert.equal(declared.get(id)?.icon, declared.get(command)?.icon);
      assert.equal(declared.get(id)?.enablement, declared.get(command)?.enablement);
    }
  }
});

test("the dashboard view menu marks the selected sort in flat mode", () => {
  const menus = pkg.contributes.menus!;
  const sortMenus = menus as Record<string, { command: string; when?: string; group?: string }[]>;
  for (const suffix of ["", ".en", ".ru"]) {
    const submenu = `mf-dashboard.viewSort${suffix}`;
    assert.ok(pkg.contributes.submenus?.some(({ id }) => id === submenu));
    const entry = menus["view/title"]?.find((item) => item.submenu === submenu);
    assert.match(entry?.when ?? "", /^view == mf-dashboard && /);
    for (const order of ["Name", "Port"]) {
      const id = `mf-dashboard.sortBy${order}`;
      const normal = sortMenus[submenu]?.find(({ command }) => command === id + suffix);
      const checked = sortMenus[submenu]?.find(
        ({ command }) => command === id + "Checked" + suffix,
      );
      assert.equal(normal?.when, `mf-dashboard.flatSort != ${order.toLowerCase()}`);
      assert.equal(checked?.when, `mf-dashboard.flatSort == ${order.toLowerCase()}`);
      assert.equal(checked?.group, normal?.group);
      for (const item of [normal, checked]) {
        assert.equal(
          pkg.contributes.commands?.find(({ command }) => command === item?.command)?.enablement,
          "mf-dashboard.flat && !mf-dashboard.discovering",
        );
      }
    }
  }
});

test("mf-types offers a layout switch and a rebuild action on app rows", () => {
  const menus = pkg.contributes.menus!;
  for (const [name, surface, condition] of [
    ["typesUseFlat", "view/title", " && !mf-dashboard.typesFlat"],
    ["typesUseTree", "view/title", " && mf-dashboard.typesFlat"],
    ["rebuildAllTypes", "view/title", " && mf-dashboard.canUpdateTypes"],
    ["openTypesBuildReport", "view/title", ""],
    ["rebuildAppTypes", "view/item/context", " && viewItem == typesBuildApp"],
  ] as const) {
    const prefix = `view == mf-dashboard.typesBuild${condition}`;
    const entries = menus[surface]?.filter((entry) => entry.when?.startsWith(prefix));
    for (const [suffix, locale] of [
      ["", "!= en && config.mf-dashboard.language != ru"],
      [".en", "== en"],
      [".ru", "== ru"],
    ]) {
      assert.equal(
        entries?.find((entry) => entry.command === `mf-dashboard.${name}${suffix}`)?.when,
        `${prefix} && config.mf-dashboard.language ${locale}`,
      );
    }
  }
  assert.equal(
    pkg.contributes.commands?.find((entry) => entry.command === "mf-dashboard.rebuildAppTypes.ru")
      ?.enablement,
    "isWorkspaceTrusted && mf-dashboard.canUpdateTypes",
  );
  const titles = new Map(pkg.contributes.commands?.map(({ command, title }) => [command, title]));
  assert.equal(titles.get("mf-dashboard.useFlat.ru"), "Показывать плоским списком");
  assert.equal(titles.get("mf-dashboard.typesUseFlat.ru"), "Показывать плоским списком");
  assert.equal(en["view.typesBuild"], "@mf-types Build");
  assert.equal(ru["view.typesBuild"], "Сборка @mf-types");
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

test("Start stays inline while Rebuild and Fetch use the types context menu", () => {
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

  const items = pkg.contributes.menus?.["view/item/context"] ?? [];
  const byCommand = new Map(items.map((item) => [item.command, item]));
  assert.deepEqual(byCommand.get("mf-dashboard.start"), {
    command: "mf-dashboard.start",
    when: "view == mf-dashboard && !mf-dashboard.discovering && viewItem =~ /^(silent|unknownPort)($| )/ && config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
    group: "inline",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.rebuildTypes"), {
    command: "mf-dashboard.rebuildTypes",
    when: "view == mf-dashboard && !mf-dashboard.discovering && viewItem =~ /^stale($| )/ && config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
    group: "1_types@2",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.refetchTypes"), {
    command: "mf-dashboard.refetchTypes",
    when: "view == mf-dashboard && !mf-dashboard.discovering && viewItem =~ /^unfetched($| )/ && config.mf-dashboard.language != en && config.mf-dashboard.language != ru",
    group: "1_types@3",
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
          when: `view == mf-dashboard && viewItem =~ /(^| )${token}($| )/ && config.mf-dashboard.language != en && config.mf-dashboard.language != ru`,
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
    for (const [language, bundle] of [
      ["en", en],
      ["ru", ru],
    ] as const) {
      const translated = `${command}.${language}`;
      assert.deepEqual(
        menus.find((item) => item.command === translated),
        {
          command: translated,
          when: `view == mf-dashboard && viewItem =~ /(^| )${token}($| )/ && config.mf-dashboard.language == ${language}`,
          group: "navigation",
        },
      );
      assert.equal(
        pkg.contributes.commands?.find((item) => item.command === translated)?.title,
        bundle[key],
      );
    }
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
  assert.equal(
    pkg.contributes.menus?.commandPalette?.find(
      (item) => item.command === "mf-dashboard.showLogs.ru",
    )?.when,
    "config.mf-dashboard.language == ru",
  );
});
