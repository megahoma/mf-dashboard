import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectTerms } from "../src/shared/config/select-terms.ts";

const russian = JSON.parse(
  readFileSync(new URL("../l10n/bundle.l10n.ru.json", import.meta.url), "utf8"),
) as Record<string, string>;

test("en returns English source labels", () => {
  const selected = selectTerms("en", () => "translated", { listening: "WRONG" });
  assert.equal(selected.listen, "listening");
  assert.equal(selected.stale, "types not rebuilt");
  assert.equal(selected.unfetched, "types not updated");
  assert.equal(selected.manifestOff, "disabled in config");
  assert.equal(selected.noWorkspace, "not in workspace");
});

test("ru uses the Russian bundle and not the auto translator", () => {
  const selected = selectTerms("ru", () => "translated", russian);
  assert.equal(selected.listen, "работает");
  assert.equal(selected.silent, "остановлен");
  assert.equal(selected.otherHost, "URL не локальный");
  assert.equal(selected.otherPort, "URL на другой порт");
  assert.equal(selected.stale, "типы не пересобраны");
  assert.equal(selected.unfetched, "типы не обновлены");
  assert.equal(selected.invalidUrl, "ошибка URL");
  assert.equal(selected.answers, "доступен");
  assert.equal(selected.noAnswer, "недоступен");
  assert.equal(selected.matches, "совпадает");
  assert.equal(selected.start, "Запустить");
  assert.equal(selected.rebuild, "Сгенерировать типы");
  assert.equal(selected.refetch, "Загрузить @mf-types");
  assert.equal(selected.refetchPending, "ожидаем загрузку типов");
  assert.equal(selected.typesUnknown, "свежесть типов неизвестна");
  assert.equal(selected.refresh, "Обновить");
  assert.equal(selected.discover, "Найти микрофронты");
  assert.equal(selected.urlMissing, "URL отсутствует");
  assert.equal(selected.urlMalformed, "URL некорректен");
  assert.equal(selected.empty, "Конфиги Module Federation не найдены");
  assert.equal(selected.scriptMissing, "script не найден");
  assert.equal(selected.exposes, "экспорты");
  assert.equal(selected.shared, "общие");
  assert.equal(selected.singleton, "синглтон");
  assert.equal(selected.folder, "каталог");
  assert.equal(selected.localPort, "локальный порт");
  assert.equal(selected.manifest, "манифест");
  assert.equal(selected.manifestOff, "выключен в конфиге");
  assert.equal(selected.url, "URL");
  assert.equal(selected.portInUrl, "порт в URL");
  assert.equal(selected.link, "связь");
  assert.equal(selected.externalManifest, "внешний манифест");
  assert.equal(selected.types, "типы");
  assert.equal(selected.zip, "zip");
  assert.equal(selected.noWorkspace, "нет в воркспейсе");
});

test("ru keeps the English source when the bundle has no phrase", () => {
  const selected = selectTerms("ru", () => "translated", {});
  assert.equal(selected.typesDisabled, "type consumption disabled");
  assert.equal(selected.refetchFailed, "types download failed");
});

test("ru translates disabled consumption and a failed download", () => {
  const selected = selectTerms("ru", () => "translated", russian);
  assert.equal(selected.typesDisabled, "потребление типов выключено");
  assert.equal(selected.refetchFailed, "загрузка типов не удалась");
});

test("auto translates each source string with the provided function", () => {
  const selected = selectTerms("auto", (message) => `auto:${message}`, { stopped: "WRONG" });
  assert.equal(selected.silent, "auto:stopped");
  assert.equal(selected.discover, "auto:Find microfrontends");
});
