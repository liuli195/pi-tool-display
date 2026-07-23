import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { installPiHostAdapter } from "../src/pi-host-adapter.ts";

initTheme(undefined, false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const output = { content: [{ type: "text", text: "a:1\nb:2\nc:3" }], details: {} };
const render = (value: any) => value.render(120).join("\n");

function resolver(mode: "hidden" | "count" | "preview") {
  return createToolDisplayResolver(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, searchOutputMode: mode }), createRendererCatalog());
}

test("grep resolves hidden, count, preview, folding, native fallback, and renderer errors through one display seam", () => {
  const native = () => ({ render: () => ["native"] });
  for (const [mode, collapsed, expanded] of [
    ["hidden", "", ""],
    ["count", "3 matches", "c:3"],
    ["preview", "a:1", "c:3"],
  ] as const) {
    const plan = resolver(mode).resolve({ toolName: "grep", arguments: { pattern: "x" } }, { result: native });
    assert.match(render(plan.result!(output, { expanded: false, isPartial: false }, theme)), new RegExp(collapsed));
    assert.match(render(plan.result!(output, { expanded: true, isPartial: false }, theme)), new RegExp(expanded));
  }
  assert.strictEqual(resolver("count").resolve({ toolName: "other", arguments: {} }, { result: native }).result, native);
  const failed = createToolDisplayResolver(() => { throw new Error("bad config"); }, createRendererCatalog());
  assert.strictEqual(failed.resolve({ toolName: "grep", arguments: {} }, { result: native }).result, native);
  const brokenRenderer = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, {
    resolve: (_row, _config, slots) => ({ ...slots, result: () => { throw new Error("broken renderer"); } }),
  });
  assert.equal(render(brokenRenderer.resolve({ toolName: "grep", arguments: {} }, { result: native }).result!(output, { expanded: false, isPartial: false }, theme)), "native");
});

test("Pi Host Adapter installs transactionally, idempotently, and restores only its own patch", () => {
  const prototype = ToolExecutionComponent.prototype as any;
  const originalCall = prototype.getCallRenderer;
  const originalResult = prototype.getResultRenderer;
  const first = installPiHostAdapter(prototype, resolver("count"), "0.80.3");
  assert.equal(first.installed, true);
  const patched = prototype.getResultRenderer;
  const second = installPiHostAdapter(prototype, resolver("preview"), "0.80.3");
  assert.strictEqual(prototype.getResultRenderer, patched);
  second.dispose();
  assert.strictEqual(prototype.getResultRenderer, originalResult);
  first.dispose();
  assert.strictEqual(prototype.getCallRenderer, originalCall);

  const unsupported = { getCallRenderer: originalCall };
  assert.equal(installPiHostAdapter(unsupported, resolver("count"), "0.80.3").installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(unsupported), Object.getOwnPropertyDescriptors({ getCallRenderer: originalCall }));
  assert.equal(installPiHostAdapter(prototype, resolver("count"), "9.9.9").installed, false);
  assert.strictEqual(prototype.getCallRenderer, originalCall);
  assert.strictEqual(prototype.getResultRenderer, originalResult);

  const active = installPiHostAdapter(prototype, resolver("count"), "0.80.3");
  const foreign = function () { return originalResult.call(this); };
  prototype.getResultRenderer = foreign;
  active.dispose();
  assert.strictEqual(prototype.getResultRenderer, foreign);
  prototype.getResultRenderer = originalResult;
});
