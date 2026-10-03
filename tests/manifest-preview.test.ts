import assert from "node:assert/strict";
import { test } from "node:test";
import {
  manifestDocumentPath,
  manifestFailureMessage,
  manifestPreviewText,
} from "../src/features/open-manifest/text.ts";

test("document path keeps a safe file name", () => {
  assert.equal(manifestDocumentPath("widget"), "/widget.json");
  assert.equal(manifestDocumentPath("a/b c"), "/a-b-c.json");
  assert.equal(manifestDocumentPath("***"), "/manifest.json");
});

test("preview pretty-prints JSON and falls back to bytes", () => {
  assert.equal(manifestPreviewText({ id: "widget" }, null), '{\n  "id": "widget"\n}\n');
  assert.equal(manifestPreviewText(null, new TextEncoder().encode("not-json")), "not-json");
});

test("failure messages", () => {
  assert.equal(
    manifestFailureMessage(new Error("ignored"), 404),
    "MF dashboard: manifest is not reachable (HTTP 404)",
  );
  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  assert.equal(manifestFailureMessage(timeout), "MF dashboard: manifest request timed out");
  assert.equal(
    manifestFailureMessage(new Error("response exceeds 32 bytes")),
    "MF dashboard: manifest network error",
  );
  assert.equal(
    manifestFailureMessage(new Error("connect ECONNREFUSED")),
    "MF dashboard: manifest network error",
  );
});
