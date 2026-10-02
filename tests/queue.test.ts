import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedLock, createSerialQueue } from "../src/shared/queue.ts";

test("queued work runs one at a time, in the order it was scheduled", async () => {
  const run = createSerialQueue();
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = run(async () => {
    order.push("a");
    await gate;
    order.push("b");
  });
  const second = run(async () => {
    order.push("c");
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ["a"]);
  releaseFirst();
  await first;
  await second;
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("a keyed lock serializes one directory and lets another proceed", async () => {
  const lock = createKeyedLock();
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondSame = false;
  let other = false;
  const first = lock("/widget-1/a", async () => {
    await gate;
  });
  const same = lock("/widget-1/a", async () => {
    secondSame = true;
  });
  const different = lock("/widget-1/b", async () => {
    other = true;
  });
  await different;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(other, true);
  assert.equal(secondSame, false);
  releaseFirst();
  await first;
  await same;
  assert.equal(secondSame, true);
});
