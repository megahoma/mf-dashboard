import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedBody } from "../src/shared/http-body.ts";

test("readLimitedBody rejects a body past the limit", async () => {
  const small = new Response("hi");
  assert.equal(new TextDecoder().decode(await readLimitedBody(small, 4)), "hi");
  const declared = new Response("hello", { headers: { "content-length": "5" } });
  await assert.rejects(readLimitedBody(declared, 4), /exceeds 4 bytes/);
  const stream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    }),
  );
  await assert.rejects(readLimitedBody(stream, 4), /exceeds 4 bytes/);
});
