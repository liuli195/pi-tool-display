import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog, registerProducerRendererAdapter } from "../src/renderer-catalog.ts";
import { createPiToolDisplayResolver } from "../src/tool-display-runtime.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type CustomToolOutputMode } from "../src/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const result = { content: [{ type: "text", text: "one\ntwo\nthree" }], details: {} };
const render = (value: any) => value.render(120).join("\n");
const nativeCall = () => ({ render: () => ["native call"] });
const nativeResult = () => ({ render: () => ["native result"] });
const resolver = (outputMode: CustomToolOutputMode, overrideCallRenderer = false) => createToolDisplayResolver(
  () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 1, customToolOverrides: { third: { enabled: true, kind: "generic", outputMode, overrideCallRenderer } } }),
  createRendererCatalog(),
);

test("configured generic modes preserve native calls unless replacement is explicit", () => {
  for (const [mode, expected] of [["hidden", ""], ["summary", "3 lines returned"], ["preview", "one"]] as const) {
    const plan = resolver(mode).resolve({ toolName: "third", arguments: {} }, { call: nativeCall, result: nativeResult, shell: "native-shell" });
    assert.strictEqual(plan.call, nativeCall);
    assert.equal(plan.shell, "native-shell");
    assert.match(render(plan.result!(result, { expanded: false, isPartial: false }, theme)), new RegExp(expected));
  }
  assert.notStrictEqual(resolver("summary", true).resolve({ toolName: "third", arguments: {} }, { call: nativeCall }).call, nativeCall);
});

test("producer MCP adapters select presentation without configuring or replacing execution", () => {
  const dispose = registerProducerRendererAdapter({ id: "producer", toolName: "direct", kind: "mcp", outputMode: "summary" });
  try {
    const definition = { name: "direct", execute() { return "original"; } };
    const plan = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog()).resolve(
      { toolName: "direct", arguments: {} },
      { call: nativeCall, result: nativeResult },
    );
    assert.strictEqual(plan.call, nativeCall);
    assert.match(render(plan.result!(result, { expanded: false, isPartial: false }, theme)), /3 lines returned/);
    assert.equal(definition.execute(), "original");
  } finally { dispose(); }
});

test("late producer registration applies immediately without changing same-name tool state", () => {
  const display = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog());
  const definition = { name: "same", owner: "original", active: true, execute: () => "original" };
  const native = { call: nativeCall, result: nativeResult, shell: "shell" };
  assert.deepEqual(display.resolve({ toolName: "same", arguments: {} }, native), native);
  const dispose = registerProducerRendererAdapter({ id: "late", toolName: "same", kind: "generic", outputMode: "summary" });
  try {
    assert.match(render(display.resolve({ toolName: "same", arguments: {} }, native).result!(result, { expanded: false }, theme)), /3 lines returned/);
    assert.deepEqual({ owner: definition.owner, active: definition.active, result: definition.execute() }, { owner: "original", active: true, result: "original" });
  } finally { dispose(); }
  assert.deepEqual(display.resolve({ toolName: "same", arguments: {} }, native), native);
});

test("runtime diagnostics identify conflicts and renderer failures once each per runtime epoch", () => {
  const first = registerProducerRendererAdapter({ id: "first", toolName: "conflict", kind: "generic" });
  const second = registerProducerRendererAdapter({ id: "second", toolName: "conflict", kind: "mcp" });
  try {
    const diagnostics: Array<{ message: string; error: unknown }> = [];
    const runtime = createPiToolDisplayResolver({} as any, () => DEFAULT_TOOL_DISPLAY_CONFIG, (message, error) => diagnostics.push({ message, error }));
    const native = { call: nativeCall, result: nativeResult };
    runtime.resolve({ toolName: "conflict", arguments: {} }, native);
    runtime.resolve({ toolName: "conflict", arguments: {} }, native);
    assert.deepEqual(diagnostics.map(({ message }) => message), [
      "tool-display adapter-conflict tool=conflict adapters=first:generic,second:mcp",
    ]);
    createPiToolDisplayResolver({} as any, () => DEFAULT_TOOL_DISPLAY_CONFIG, (message, error) => diagnostics.push({ message, error }))
      .resolve({ toolName: "conflict", arguments: {} }, native);
    assert.equal(diagnostics.length, 2, "a real reload starts a new diagnostic epoch");

    const failures: Array<{ message: string; error: unknown }> = [];
    const broken = createPiToolDisplayResolver({} as any, () => ({
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      customToolOverrides: { broken: { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: false } },
    }), (message, error) => failures.push({ message, error }));
    const renderer = broken.resolve({ toolName: "broken", arguments: {} }, native).result!;
    const brokenTheme = { ...theme, fg: () => { throw new Error("theme broke"); } };
    renderer(result, { expanded: false }, brokenTheme);
    renderer(result, { expanded: false }, brokenTheme);
    assert.deepEqual(failures.map(({ message }) => message), ["tool-display renderer-failure tool=broken slot=result"]);
  } finally { second(); first(); }
});

test("producer conflicts fail open with one diagnostic regardless of registration order", () => {
  const first = registerProducerRendererAdapter({ id: "first", toolName: "conflict", kind: "generic" });
  const second = registerProducerRendererAdapter({ id: "second", toolName: "conflict", kind: "mcp" });
  try {
    let diagnostics = 0;
    const display = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog(), () => { diagnostics++; });
    const native = { call: nativeCall, result: nativeResult, shell: "shell" };
    assert.deepEqual(display.resolve({ toolName: "conflict", arguments: {} }, native), native);
    assert.deepEqual(display.resolve({ toolName: "conflict", arguments: {} }, native), native);
    assert.equal(diagnostics, 1);
  } finally { second(); first(); }
});

test("unconfigured tools stay native and renderer failures emit one diagnostic then fail open", () => {
  const catalog = createRendererCatalog();
  const native = { call: nativeCall, result: nativeResult, shell: "shell" };
  assert.deepEqual(createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, catalog).resolve({ toolName: "plain", arguments: {} }, native), native);

  let diagnostics = 0;
  const broken = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, {
    resolve: (_row, _config, slots) => ({ ...slots, result: () => { throw new Error("broken"); } }),
  }, () => { diagnostics++; });
  const renderer = broken.resolve({ toolName: "plain", arguments: {} }, native).result!;
  assert.equal(render(renderer(result, { expanded: false }, theme)), "native result");
  assert.equal(render(renderer(result, { expanded: false }, theme)), "native result");
  assert.equal(diagnostics, 1);
});
