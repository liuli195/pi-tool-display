import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any, width = 120) => component.render(width).join("\n");
const resolver = (overrides = {}) => createToolDisplayResolver(
  () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, edit: true }, ...overrides }),
  createRendererCatalog(),
);
const native = () => ({ render: () => ["native edit"] });

function plan(args: Record<string, unknown>) {
  return resolver().resolve({ toolName: "edit", arguments: args, builtIn: true }, { call: native, result: native });
}

test("edit renders supplied old/new evidence without mutating bytes", () => {
  const args = { path: "src/a.ts", oldText: "const value = 1;\n", newText: "const value = 2;\n" };
  const result = { content: [{ type: "text", text: "Edited src/a.ts" }], details: {} };
  const beforeArgs = JSON.stringify(args);
  const beforeResult = JSON.stringify(result);
  const selected = plan(args);

  const call = render(selected.call!(args, theme, { isPartial: true, argsComplete: true }));
  const output = render(selected.result!(result, { expanded: true, isPartial: false }, theme, { args }));

  assert.match(call, /edit.*src\/a\.ts/);
  assert.match(call, /const value = .*1/);
  assert.match(output, /const value = .*1/);
  assert.match(output, /const value = .*2/);
  assert.equal(JSON.stringify(args), beforeArgs);
  assert.equal(JSON.stringify(result), beforeResult);
});

test("edit preserves explicit result diff line and hashline evidence across folding", () => {
  const diff = "@@ -7,1 +7,1 @@\n-  7#AB:old value\n+  7#CD:new value";
  const selected = plan({ path: "a.ts", oldText: "old", newText: "new" });
  const result = { content: [{ type: "text", text: "Done" }], details: { diff } };

  const collapsed = render(selected.result!(result, { expanded: false, isPartial: false }, theme));
  const expanded = render(selected.result!(result, { expanded: true, isPartial: false }, theme));
  assert.match(collapsed, /7/);
  assert.doesNotMatch(collapsed, /#AB/);
  assert.match(expanded, /7#AB/);
  assert.match(expanded, /7#CD/);
});

test("edit malformed or missing evidence degrades truthfully and keeps states usable", () => {
  const selected = plan({ path: "a.ts", oldText: "only-before" });
  const malformed = { content: [{ type: "text", text: "Original result remains" }], details: { diff: "not a diff" } };
  assert.match(render(selected.result!(malformed, { expanded: false, isPartial: false }, theme)), /Original result remains/);
  assert.match(render(selected.result!({ content: [], details: {} }, { expanded: false, isPartial: false }, theme)), /no diff payload/);
  assert.match(render(selected.result!({ content: [{ type: "text", text: "permission denied" }], isError: true }, { expanded: false, isPartial: false }, theme)), /permission denied/);
  assert.match(render(selected.result!({ content: [], details: {} }, { expanded: false, isPartial: true }, theme)), /editing/);
  assert.match(render(selected.result!({ content: [{ type: "text", text: "aborted" }], details: {} }, { expanded: false, isPartial: false }, theme, { isError: true })), /aborted/);
});

test("unconfigured edit remains native", () => {
  const selected = createToolDisplayResolver(
    () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, edit: false } }),
    createRendererCatalog(),
  ).resolve({ toolName: "edit", arguments: {}, builtIn: true }, { call: native, result: native });
  assert.strictEqual(selected.call, native);
  assert.strictEqual(selected.result, native);
});
