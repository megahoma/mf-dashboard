import assert from "node:assert/strict";
import test from "node:test";
import { terms } from "../src/shared/config/terms.ts";
import { icons } from "../src/shared/config/icons.ts";

const statusKeys = [
  "listen",
  "silent",
  "otherHost",
  "otherPort",
  "stale",
  "unfetched",
  "invalidUrl",
  "answers",
  "noAnswer",
] as const;
const labelKeys = [
  "empty",
  "scriptMissing",
  "start",
  "folder",
  "localPort",
  "manifest",
  "manifestOff",
  "url",
  "portInUrl",
  "link",
  "matches",
  "externalManifest",
  "types",
  "zip",
  "noWorkspace",
  "rebuild",
  "refetch",
  "refetchPending",
  "typesUnknown",
  "typesDisabled",
  "refetchFailed",
  "refresh",
  "discover",
  "urlMissing",
  "urlMalformed",
] as const;

test("every status the panel can show has a label and an icon", () => {
  for (const key of statusKeys) {
    assert.equal(typeof terms[key], "string");
    assert.equal(typeof icons[key], "string");
    assert.ok(terms[key].length > 0);
    assert.ok(icons[key].length > 0);
  }
  for (const key of labelKeys) assert.equal(typeof terms[key], "string");
});
