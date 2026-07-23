import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog, registerProducerRendererAdapter } from "../src/renderer-catalog.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const row = { toolName: "third_party", arguments: {}, builtIn: false } as const;

test("producer registration is disposable, deterministic, and leaves its input unchanged", () => {
  const adapter = Object.freeze({ id: "producer-a", toolName: "third_party", kind: "generic" as const });
  const dispose = registerProducerRendererAdapter(adapter);
  const catalog = createRendererCatalog();
  assert.ok(catalog.resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}));
  dispose(); dispose();
  assert.equal(catalog.resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}), undefined);
  assert.deepEqual(adapter, { id: "producer-a", toolName: "third_party", kind: "generic" });
});

test("equal-priority producer conflicts fail deterministically regardless of order", () => {
  const first = registerProducerRendererAdapter({ id: "z", toolName: "third_party", kind: "generic" });
  const second = registerProducerRendererAdapter({ id: "a", toolName: "third_party", kind: "mcp" });
  try {
    assert.throws(() => createRendererCatalog().resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}), /a \(mcp\), z \(generic\)/);
  } finally { second(); first(); }
});
