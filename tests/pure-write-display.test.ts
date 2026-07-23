import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any, width = 120) => component.render(width).join("\n");
const native = () => ({ render: () => ["native write"] });
const resolver = (enabled = true) => createToolDisplayResolver(
  () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, write: enabled } }),
  createRendererCatalog(),
);
const plan = (args: Record<string, unknown>) => resolver().resolve(
  { toolName: "write", arguments: args, builtIn: true },
  { call: native, result: native },
);

test("write content renders neutral call summary and never fabricates file semantics", () => {
  const args = { path: "src/new.ts", content: "one\ntwo\n" };
  const result = { content: [{ type: "text", text: "Wrote src/new.ts" }], details: {} };
  const beforeArgs = JSON.stringify(args);
  const beforeResult = JSON.stringify(result);
  const selected = plan(args);

  const call = render(selected.call!(args, theme, { isPartial: false, argsComplete: true }));
  const output = render(selected.result!(result, { expanded: true, isPartial: false }, theme));

  assert.match(call, /write.*src\/new\.ts.*2 lines.*8 bytes/);
  assert.match(output, /Wrote src\/new\.ts/);
  assert.doesNotMatch(`${call}\n${output}`, /additions?|deletions?|creat(?:e|ed|ion)|overwrite/i);
  assert.equal(JSON.stringify(args), beforeArgs);
  assert.equal(JSON.stringify(result), beforeResult);
});

test("write renders only explicit diff evidence and preserves folding", () => {
  const selected = plan({ path: "a.ts", content: "new" });
  const result = { content: [{ type: "text", text: "Done" }], details: { patch: "@@ -7,1 +7,1 @@\n-  7#AB:old\n+  7#CD:new" } };
  const collapsed = render(selected.result!(result, { expanded: false, isPartial: false }, theme));
  const expanded = render(selected.result!(result, { expanded: true, isPartial: false }, theme));
  assert.doesNotMatch(collapsed, /#AB/);
  assert.match(expanded, /7#AB/);
  assert.match(expanded, /7#CD/);
});

test("write states remain truthful without diff evidence", () => {
  const selected = plan({ file_path: "a.ts", content: "hello" });
  assert.match(render(selected.call!({ file_path: "a.ts", content: "hello" }, theme, { isPartial: true, argsComplete: false })), /write.*a\.ts/);
  assert.match(render(selected.result!({ content: [], details: {} }, { expanded: false, isPartial: true }, theme)), /writing/);
  assert.match(render(selected.result!({ content: [{ type: "text", text: "permission denied" }], isError: true }, { expanded: false, isPartial: false }, theme)), /permission denied/);
  assert.match(render(selected.result!({ content: [{ type: "text", text: "old schema result" }] }, { expanded: false, isPartial: false }, theme)), /old schema result/);
});

test("write rendering performs zero node:fs workspace reads", async () => {
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
    const selected = plan({ path: "a.ts", content: "hello" });
    render(selected.call!({ path: "a.ts", content: "hello" }, theme, { isPartial: true, argsComplete: true }));
    render(selected.result!({ content: [{ type: "text", text: "Done" }], details: {} }, { expanded: true, isPartial: false }, theme));
    assert.equal(reads, 0);
  } finally {
    for (const [owner, values] of originals) for (const [key, value] of values) owner[key] = value;
    syncBuiltinESMExports();
  }
});

test("unconfigured write remains native", () => {
  const selected = resolver(false).resolve({ toolName: "write", arguments: {}, builtIn: true }, { call: native, result: native });
  assert.strictEqual(selected.call, native);
  assert.strictEqual(selected.result, native);
});
