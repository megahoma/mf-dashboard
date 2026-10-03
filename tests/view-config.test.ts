import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
  contributes: {
    commands?: { command: string; title: string }[];
    viewsWelcome?: { view: string; contents: string }[];
    menus?: {
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

function welcomeContents(): string {
  const entry = pkg.contributes.viewsWelcome?.find((item) => item.view === "mf-dashboard");
  assert.ok(entry, "viewsWelcome for mf-dashboard");
  return entry.contents;
}

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
    when: "view == mf-dashboard && viewItem == silent",
    group: "inline",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.rebuildTypes"), {
    command: "mf-dashboard.rebuildTypes",
    when: "view == mf-dashboard && viewItem == stale",
    group: "inline",
  });
  assert.deepEqual(byCommand.get("mf-dashboard.refetchTypes"), {
    command: "mf-dashboard.refetchTypes",
    when: "view == mf-dashboard && viewItem == unfetched",
    group: "inline",
  });
});
