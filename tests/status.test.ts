import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classify, grayLabel } from "../src/entities/status/index.ts";
import { terms } from "../src/shared/config/terms.ts";
import { invalidUrlHint } from "../src/entities/status/index.ts";
import { rowModel } from "../src/entities/status/index.ts";
import { selectTerms } from "../src/shared/config/index.ts";

const base = {
  role: "link" as const,
  port: 4100,
  portOpen: true,
  manifestEnabled: true,
  buildVersion: "1.0.0",
  url: "http://127.0.0.1:4100/mf-manifest.json",
  typesState: "ok" as const,
};

test("healthy link is listen with version", () => {
  assert.equal(classify(base), "listen");
  assert.equal(grayLabel("listen", base), ":4100 · " + terms.listen + " · 1.0.0");
});

test("a root with a foreign url stays listen and keeps the local gray line", () => {
  const input = {
    ...base,
    role: "app" as const,
    url: "http://example.com/widget-1/mf-manifest.json",
  };
  assert.equal(classify(input), "listen");
  assert.equal(grayLabel("listen", input), ":4100 · " + terms.listen + " · 1.0.0");
});

test("stale-source classifies as stale", () => {
  const input = { ...base, typesState: "stale-source" as const };
  assert.equal(classify(input), "stale");
});

test("closed port wins over a foreign host", () => {
  const input = {
    ...base,
    port: 4400,
    portOpen: false,
    url: "http://example.com/widget-1/mf-manifest.json",
  };
  assert.equal(classify(input), "silent");
  assert.equal(grayLabel("silent", input), ":4400 · " + terms.silent);
});

test("stale types win over a foreign host", () => {
  const input = {
    ...base,
    port: 4200,
    url: "http://example.com/widget-1/mf-manifest.json",
    typesState: "stale-source" as const,
  };
  assert.equal(classify(input), "stale");
});

test("foreign host without an explicit port is otherHost", () => {
  const input = {
    ...base,
    url: "http://example.com/widget-1/mf-manifest.json",
    typesState: "ok" as const,
  };
  assert.equal(classify(input), "otherHost");
  assert.equal(grayLabel("otherHost", input), ":4100 · " + terms.otherHost);
});

test("external url without a port has no colon-port", () => {
  const input = {
    ...base,
    role: "external" as const,
    port: null,
    url: "https://static.example/cdn/mf-manifest.json",
  };
  assert.equal(classify(input), "answers");
  assert.equal(grayLabel("answers", input), "static.example · " + terms.answers);
});

test("local url without a port compares as port 80", () => {
  const input = { ...base, url: "http://127.0.0.1/mf-manifest.json" };
  assert.equal(classify(input), "otherPort");
});

test("missing or malformed url has its own status", () => {
  assert.equal(classify({ ...base, url: null }), "invalidUrl");
  assert.equal(classify({ ...base, url: "not a url" }), "invalidUrl");
  const external = { ...base, role: "external" as const, port: null, url: null, portOpen: false };
  assert.equal(classify(external), "invalidUrl");
  assert.equal(grayLabel("invalidUrl", external), terms.invalidUrl);
  assert.equal(
    classify({ ...external, url: "https://static.example/mf-manifest.json" }),
    "noAnswer",
  );
});

test("a root with a closed port is silent and ignores types and url", () => {
  const input = {
    ...base,
    role: "app" as const,
    portOpen: false,
    url: null,
    typesState: "stale-source" as const,
  };
  assert.equal(classify(input), "silent");
  assert.equal(grayLabel("silent", input), ":4100 · " + terms.silent);
});

test("a root stays listen when types are stale or the url is not http", () => {
  assert.equal(
    classify({
      ...base,
      role: "app" as const,
      typesState: "unfetched" as const,
      url: "ftp://files.example/a",
    }),
    "listen",
  );
});

test("listen omits the version when the manifest is disabled or missing", () => {
  assert.equal(grayLabel("listen", { ...base, manifestEnabled: false }), ":4100 · " + terms.listen);
  assert.equal(grayLabel("listen", { ...base, buildVersion: null }), ":4100 · " + terms.listen);
  assert.equal(grayLabel("listen", { ...base, buildVersion: "" }), ":4100 · " + terms.listen);
});

test("closed port wins over stale, unfetched, and an invalid url", () => {
  assert.equal(
    classify({ ...base, portOpen: false, typesState: "stale-source" as const, url: null }),
    "silent",
  );
  assert.equal(classify({ ...base, portOpen: false, typesState: "unfetched" as const }), "silent");
});

test("unfetched wins over a foreign host and a bad url", () => {
  assert.equal(
    classify({
      ...base,
      typesState: "unfetched" as const,
      url: "http://example.com/mf-manifest.json",
    }),
    "unfetched",
  );
  assert.equal(classify({ ...base, typesState: "unfetched" as const, url: null }), "unfetched");
  assert.equal(
    grayLabel("unfetched", { ...base, port: 4300, typesState: "unfetched" as const }),
    ":4300 · " + terms.unfetched,
  );
});

test("stale wins over an invalid url", () => {
  assert.equal(
    classify({
      ...base,
      typesState: "stale-source" as const,
      url: "ftp://files.example/mf-manifest.json",
    }),
    "stale",
  );
  assert.equal(
    grayLabel("stale", { ...base, port: 4200, typesState: "stale-source" as const }),
    ":4200 · " + terms.stale,
  );
});

test("none, manual, and unknown stay listen on a local url and otherHost on a foreign url", () => {
  for (const typesState of ["none", "manual", "unknown"] as const) {
    assert.equal(classify({ ...base, typesState }), "listen");
    assert.equal(
      classify({ ...base, typesState, url: "http://example.com/mf-manifest.json" }),
      "otherHost",
    );
  }
});

test("empty, unsubstituted, and non-http urls are invalid", () => {
  assert.equal(classify({ ...base, url: "" }), "invalidUrl");
  assert.equal(classify({ ...base, url: "   " }), "invalidUrl");
  assert.equal(classify({ ...base, url: "http://${HOST}/mf-manifest.json" }), "invalidUrl");
  assert.equal(classify({ ...base, url: "${HOST}" }), "invalidUrl");
  assert.equal(classify({ ...base, url: "ftp://files.example/mf-manifest.json" }), "invalidUrl");
  assert.equal(classify({ ...base, url: "ws://127.0.0.1:4100/mf-manifest.json" }), "invalidUrl");
  assert.equal(grayLabel("invalidUrl", { ...base, url: null }), ":4100 · " + terms.invalidUrl);
});

test("localhost and 127.0.0.1 are one local host", () => {
  assert.equal(classify({ ...base, url: "http://localhost:4100/mf-manifest.json" }), "listen");
  assert.equal(classify({ ...base, url: "HTTP://LOCALHOST:4100/mf-manifest.json" }), "listen");
  assert.equal(
    classify({ ...base, port: 443, url: "https://localhost/mf-manifest.json" }),
    "listen",
  );
  assert.equal(classify({ ...base, url: "http://[::1]:4100/mf-manifest.json" }), "otherHost");
});

test("local host with another explicit port is otherPort", () => {
  const input = { ...base, url: "http://localhost:4200/mf-manifest.json" };
  assert.equal(classify(input), "otherPort");
  assert.equal(grayLabel("otherPort", input), ":4100 · " + terms.otherPort);
});

test("https without a port compares as 443", () => {
  assert.equal(classify({ ...base, url: "https://127.0.0.1/mf-manifest.json" }), "otherPort");
  assert.equal(
    classify({ ...base, port: 443, url: "https://127.0.0.1/mf-manifest.json" }),
    "listen",
  );
});

test("an explicit default port still counts as 80 or 443", () => {
  assert.equal(classify({ ...base, url: "http://127.0.0.1:80/mf-manifest.json" }), "otherPort");
  assert.equal(
    classify({ ...base, port: 80, url: "http://localhost:80/mf-manifest.json" }),
    "listen",
  );
  assert.equal(classify({ ...base, url: "https://127.0.0.1:443/mf-manifest.json" }), "otherPort");
  assert.equal(
    classify({ ...base, port: 443, url: "https://127.0.0.1:443/mf-manifest.json" }),
    "listen",
  );
});

test("a foreign host on the same port is still otherHost", () => {
  assert.equal(classify({ ...base, url: "http://example.com:4100/mf-manifest.json" }), "otherHost");
});

test("an undeclared link port is not silent", () => {
  const input = {
    ...base,
    port: null,
    portOpen: false,
    url: "http://127.0.0.1:4100/mf-manifest.json",
  };
  assert.equal(classify(input), "otherPort");
});

test("implicit ports 80 and 443 are not written into the gray line", () => {
  const http = { ...base, port: 80, url: "http://127.0.0.1/mf-manifest.json" };
  assert.equal(classify(http), "listen");
  assert.equal(grayLabel("listen", http), terms.listen + " · 1.0.0");
  const https = { ...base, port: 443, url: "https://localhost/mf-manifest.json" };
  assert.equal(classify(https), "listen");
  assert.equal(grayLabel("listen", https), terms.listen + " · 1.0.0");
  assert.equal(grayLabel("silent", { ...https, portOpen: false }), terms.silent);
  assert.equal(grayLabel("listen", { ...http, manifestEnabled: false }), terms.listen);
});

test("external checks the url before the manifest answer and ignores types", () => {
  const up = {
    ...base,
    role: "external" as const,
    port: null,
    portOpen: true,
    typesState: "stale-source" as const,
    url: "https://static.example/mf-manifest.json",
  };
  assert.equal(classify(up), "answers");
  assert.equal(classify({ ...up, url: null }), "invalidUrl");
  assert.equal(classify({ ...up, url: "ftp://static.example/mf-manifest.json" }), "invalidUrl");
  assert.equal(classify({ ...up, url: "http://${HOST}/mf-manifest.json" }), "invalidUrl");
  assert.equal(classify({ ...up, portOpen: false }), "noAnswer");
  assert.equal(
    grayLabel("noAnswer", { ...up, portOpen: false }),
    "static.example · " + terms.noAnswer,
  );
  assert.equal(grayLabel("invalidUrl", { ...up, url: "not a url" }), terms.invalidUrl);
});

test("an external gray line never prints a port", () => {
  const input = {
    ...base,
    role: "external" as const,
    port: 8443,
    url: "https://static.example:8443/cdn/mf-manifest.json",
  };
  assert.equal(classify(input), "answers");
  assert.equal(grayLabel("answers", input), "static.example · " + terms.answers);
  const implicit = { ...input, port: null, url: "http://static.example/mf-manifest.json" };
  assert.equal(grayLabel("answers", implicit), "static.example · " + terms.answers);
});

test("row model uses the classified label", () => {
  const row = rowModel(base);
  assert.equal(row.kind, "listen");
  assert.equal(row.description, grayLabel("listen", base));
});

test("row model tooltip includes the folder, port, url, and status word", () => {
  const input = { ...base, folder: "widget-1" };
  const row = rowModel(input);
  assert.equal(row.description, grayLabel("listen", base));
  assert.equal(row.description.split(terms.listen).length, 2);
  assert.match(row.tooltip, /widget-1/);
  assert.match(row.tooltip, /4100/);
  assert.match(row.tooltip, /http:\/\/127\.0\.0\.1:4100\/mf-manifest\.json/);
  assert.match(row.tooltip, new RegExp(terms.listen));
  assert.equal(rowModel(base).tooltip.includes("widget-1"), false);
});

test("gray label and row model follow selected terms and keep the english default", () => {
  const russian = JSON.parse(
    readFileSync(new URL("../l10n/bundle.l10n.ru.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const selected = selectTerms("ru", () => "translated", russian);
  assert.equal(grayLabel("listen", base, selected), ":4100 · " + selected.listen + " · 1.0.0");
  assert.equal(grayLabel("listen", base), ":4100 · " + terms.listen + " · 1.0.0");
  const row = rowModel({ ...base, folder: "widget-1" }, selected);
  assert.equal(row.kind, "listen");
  assert.equal(row.description, grayLabel("listen", base, selected));
  assert.match(row.tooltip, /работает/);
  assert.match(row.tooltip, /каталог/);
  assert.match(row.tooltip, /widget-1/);
});

test("an external row model is invalidUrl, answers, or noAnswer", () => {
  const external = {
    ...base,
    role: "external" as const,
    port: null,
    url: "https://static.example/mf-manifest.json",
  };
  assert.equal(rowModel(external).kind, "answers");
  assert.equal(rowModel(external).description, grayLabel("answers", external));
  assert.equal(rowModel({ ...external, portOpen: false }).kind, "noAnswer");
  const broken = rowModel({ ...external, url: "not a url" });
  assert.equal(broken.kind, "invalidUrl");
  assert.match(broken.tooltip, new RegExp(terms.urlMalformed));
  assert.equal(broken.description, terms.invalidUrl);
});

test("request failures appear in tooltips without changing the status", () => {
  const external = { ...base, role: "external" as const, port: null, portOpen: false };
  const russian = JSON.parse(
    readFileSync(new URL("../l10n/bundle.l10n.ru.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const selected = selectTerms("ru", (message) => message, russian);
  for (const [requestFailure, hint] of [
    ["HTTP 404", "HTTP 404"],
    ["timeout", "время ожидания запроса истекло"],
    ["network", "ошибка сети"],
  ]) {
    const row = rowModel({ ...external, requestFailure }, selected);
    assert.equal(row.kind, "noAnswer");
    assert.equal(row.description, grayLabel("noAnswer", external, selected));
    assert.ok(row.tooltip.includes(hint));
  }
});

test("the invalid url hint says whether the address is missing or malformed", () => {
  assert.equal(invalidUrlHint(null), terms.urlMissing);
  assert.equal(invalidUrlHint(""), terms.urlMissing);
  assert.equal(invalidUrlHint("   "), terms.urlMissing);
  assert.equal(invalidUrlHint("not a url"), terms.urlMalformed);
  assert.equal(invalidUrlHint("ftp://files.example/mf-manifest.json"), terms.urlMalformed);
  assert.equal(invalidUrlHint("http://${HOST}/mf-manifest.json"), terms.urlMalformed);
  assert.equal(invalidUrlHint("${HOST}"), terms.urlMalformed);
  assert.equal(invalidUrlHint("http://127.0.0.1:4100/mf-manifest.json"), null);
});
