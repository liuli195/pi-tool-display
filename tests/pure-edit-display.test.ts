import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any, width = 120) => component.render(width).join("\n");
const resolver = (overrides = {}) => createToolDisplayResolver(
  () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays, edit: true }, ...overrides }),
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

test("pending edit diff honors the collapsed row state", () => {
  const args = {
    path: "a.ts",
    oldText: Array.from({ length: 30 }, (_, index) => `old ${index}`).join("\n"),
    newText: Array.from({ length: 30 }, (_, index) => `new ${index}`).join("\n"),
  };
  const selected = plan(args);

  const collapsed = render(selected.call!(args, theme, { isPartial: true, argsComplete: true, expanded: false }));
  const expanded = render(selected.call!(args, theme, { isPartial: true, argsComplete: true, expanded: true }));

  assert.match(collapsed, /more diff lines/);
  assert.doesNotMatch(collapsed, /old 29|new 29/);
  const plainExpanded = expanded.replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(plainExpanded, /more diff lines/);
  assert.match(plainExpanded, /old 29/);
  assert.match(plainExpanded, /new 29/);
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

test("edit evidence is cycle-safe, rejects mixed patches, and preserves each edit line metadata", () => {
  const selected = plan({ path: "a.ts", edits: [
    { oldText: "first", newText: "one", oldStart: 7, newStart: 8 },
    { oldText: "second", newText: "two", startLine: 20 },
  ] });
  const output = render(selected.result!({ content: [], details: {} }, { expanded: true, isPartial: false }, theme));
  assert.match(output, /7.*first/);
  assert.match(output, /20.*second/);

  const cyclic: any = { patches: [] };
  cyclic.patches.push(cyclic);
  assert.doesNotThrow(() => selected.result!({ content: [{ type: "text", text: "cycle fallback" }], details: cyclic }, { expanded: true, isPartial: false }, theme));
  const malformed = plan({ path: "a.ts" });
  assert.match(render(malformed.result!({ content: [{ type: "text", text: "mixed fallback" }], details: { patches: [{ diff: "@@ -1 +1 @@\n-a\n+b" }, { nope: true }] } }, { expanded: true, isPartial: false }, theme)), /mixed fallback/);
});

test("renderer exceptions fail open to native", () => {
  const fallback = { render: () => ["native fallback"] };
  const throwingTheme = { ...theme, fg: () => { throw new Error("renderer failed"); } };
  const selectedWithFallback = resolver().resolve(
    { toolName: "edit", arguments: { path: "a", oldText: "a", newText: "b" }, builtIn: true },
    { call: () => fallback, result: () => fallback },
  );
  assert.equal(render(selectedWithFallback.result!({ details: {} }, { expanded: true }, throwingTheme)), "native fallback");
});

test("pending edit evidence performs zero node:fs and node:fs/promises workspace reads", async () => {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const promises = require("node:fs/promises");
  const originals = new Map<any, Map<string, unknown>>();
  let reads = 0;
  for (const [owner, keys] of [[fs, ["readFileSync", "existsSync", "statSync", "realpathSync"]], [promises, ["readFile", "access", "stat", "realpath"]]] as const) {
    originals.set(owner, new Map(keys.map((key) => [key, owner[key]] as const)));
    for (const key of keys) owner[key] = () => { reads++; throw new Error("workspace read"); };
  }
  syncBuiltinESMExports();
  try {
    const preview = buildPendingEditPreviewData({ path: "a.ts", oldText: "old", newText: "new" }, process.cwd());
    assert.equal(reads, 0);
    assert.equal(preview?.previousContent, "old");
    assert.equal(buildPendingEditPreviewData({ path: "a.ts", edits: [{ oldText: "old", newText: "new" }, { nope: true }] }, process.cwd()), undefined);
  } finally {
    for (const [owner, values] of originals) for (const [key, value] of values) owner[key] = value;
    syncBuiltinESMExports();
  }
});

test("unconfigured edit remains native", () => {
  const selected = createToolDisplayResolver(
    () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays, edit: false } }),
    createRendererCatalog(),
  ).resolve({ toolName: "edit", arguments: {}, builtIn: true }, { call: native, result: native });
  assert.strictEqual(selected.call, native);
  assert.strictEqual(selected.result, native);
});
