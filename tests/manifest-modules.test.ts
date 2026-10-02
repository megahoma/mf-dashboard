import assert from "node:assert/strict";
import { test } from "node:test";
import {
  manifestTooltipLines,
  readManifestModules,
} from "../src/entities/microfrontend/manifest-modules.ts";

const terms = { exposes: "exposes", shared: "shared", singleton: "singleton" };

test("reads array exposes and shared", () => {
  const modules = readManifestModules({
    exposes: [{ path: "./Button", name: "Button" }, { name: "Header" }, { id: "skip" }],
    shared: [
      { name: "react", version: "18.2.0", singleton: true, requiredVersion: "^18" },
      { name: "react-dom", version: "18.2.0", singleton: false },
      { version: "1.0.0" },
    ],
  });
  assert.deepEqual(modules, {
    exposes: ["./Button", "Header"],
    shared: [
      { name: "react", version: "18.2.0", singleton: true },
      { name: "react-dom", version: "18.2.0", singleton: false },
    ],
  });
  assert.deepEqual(manifestTooltipLines(modules, terms), [
    "exposes: ./Button, Header",
    "shared: react@18.2.0 singleton, react-dom@18.2.0",
  ]);
});

test("reads record exposes and shared", () => {
  const modules = readManifestModules({
    exposes: { "./Button": "./src/Button.tsx", "./Header": "./src/Header.tsx" },
    shared: { react: { singleton: true, requiredVersion: "^18" } },
  });
  assert.deepEqual(modules.exposes, ["./Button", "./Header"]);
  assert.deepEqual(modules.shared, [{ name: "react", version: null, singleton: true }]);
  assert.deepEqual(manifestTooltipLines(modules, terms), [
    "exposes: ./Button, ./Header",
    "shared: react singleton",
  ]);
});

test("caps each list at eight names", () => {
  const exposes = Array.from({ length: 9 }, (_, index) => `./M${index}`);
  const lines = manifestTooltipLines(
    {
      exposes,
      shared: Array.from({ length: 9 }, (_, index) => ({
        name: `pkg${index}`,
        version: null,
        singleton: false,
      })),
    },
    terms,
  );
  assert.equal(lines[0], "exposes: 9 · ./M0, ./M1, ./M2, ./M3, ./M4, ./M5, ./M6, ./M7, …");
  assert.equal(lines[1], "shared: 9 · pkg0, pkg1, pkg2, pkg3, pkg4, pkg5, pkg6, pkg7, …");
});

test("omits empty lists and ignores a non-object manifest", () => {
  assert.deepEqual(readManifestModules(null), { exposes: [], shared: [] });
  assert.deepEqual(readManifestModules({ exposes: "nope", shared: 1 }), {
    exposes: [],
    shared: [],
  });
  assert.deepEqual(manifestTooltipLines({ exposes: [], shared: [] }, terms), []);
});
