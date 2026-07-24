import assert from "node:assert/strict";
import test from "node:test";

import { installPiHostAdapter } from "../src/pi-host-adapter.js";
import { createToolDisplayResolver } from "../src/tool-display-resolver.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.js";

const native = () => "native";

test("500-row display selection is one config and catalog lookup per row without registry access", () => {
  let configReads = 0;
  let catalogLookups = 0;
  const resolver = createToolDisplayResolver(
    () => { configReads++; return DEFAULT_TOOL_DISPLAY_CONFIG; },
    { resolve() { catalogLookups++; return {}; } },
  );
  const registry = new Proxy({}, { get() { throw new Error("display selection scanned the tool registry"); } });

  for (let index = 0; index < 500; index++) {
    const row = Object.freeze({ toolName: `tool-${index}`, arguments: Object.freeze({ index }), registry });
    assert.strictEqual(resolver.resolve(row, { call: native, result: native }).call, native);
  }

  assert.equal(configReads, 500);
  assert.equal(catalogLookups, 500);
});

test("unsupported host shape reports one concise diagnostic and preserves native execution", () => {
  let executions = 0;
  const host = { getCallRenderer() { return native; }, execute() { executions++; return "executed"; } };
  const before = Object.getOwnPropertyDescriptors(host);
  const diagnostics: string[] = [];
  const resolver = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, { resolve: () => ({}) });

  assert.equal(installPiHostAdapter(host, resolver, "0.81.1", message => diagnostics.push(message)).installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
  assert.equal(host.execute(), "executed");
  assert.equal(executions, 1);
  assert.deepEqual(diagnostics, ["pi-tool-display: unsupported Pi 0.81.1 tool-row renderer shape; using native rendering"]);
});
