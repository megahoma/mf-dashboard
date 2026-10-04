import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "vscode";
import * as stub from "./support/vscode.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vscode")
      return { url: new URL("./support/vscode.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { activate } = await import("../src/app/extension.ts");

test("activation owns one log channel and only Show Logs opens it", async () => {
  const subscriptions: { dispose(): unknown }[] = [];
  const context = {
    subscriptions,
    extensionUri: stub.Uri.file(fileURLToPath(new URL("..", import.meta.url))),
    extension: { packageJSON: { version: "test-version" } },
    extensionMode: 2,
    workspaceState: { get: () => undefined, update: async () => {} },
  } as unknown as ExtensionContext;
  try {
    activate(context);
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stub.outputChannels.length, 1);
    const channel = stub.outputChannels[0];
    assert.deepEqual(channel.options, { log: true });
    assert.equal(channel.name, "MF Dashboard");
    assert.equal(channel.shown, 0);
    assert.ok(
      channel.messages.some((text) => text.includes("extension.activated version=test-version")),
    );
    assert.equal(
      channel.messages.some((text) => text.includes("probe.started")),
      false,
      "Debug is filtered by the channel level",
    );
    await stub.registeredCommands.get("mf-dashboard.showLogs")?.();
    assert.equal(channel.shown, 1);
    channel.logLevel = stub.LogLevel.Trace;
    await stub.registeredCommands.get("mf-dashboard.refresh")?.();
    assert.equal(channel.shown, 1, "refresh does not open Output");
    assert.ok(channel.messages.some((text) => text.includes("probe.started")));
  } finally {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
  }
  assert.equal(stub.outputChannels[0].disposed, true);
});
