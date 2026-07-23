import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog, registerProducerRendererAdapter } from "../src/renderer-catalog.ts";
import { installPiHostAdapter } from "../src/pi-host-adapter.ts";
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

test("Host Adapter applies generic and MCP policy to cold history, real reload history, and new rows", () => {
  for (const kind of ["generic", "mcp"] as const) for (const [mode, expected] of [["hidden", ""], ["summary", "3 lines returned"], ["preview", "one"]] as const) {
    const host = { getCallRenderer: nativeCall, getResultRenderer: nativeResult };
    const config = () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 1, customToolOverrides: { proxy: { enabled: true, kind, outputMode: mode, overrideCallRenderer: false } } });
    const row = { toolName: "proxy", args: {}, toolDefinition: { name: "proxy", label: "Proxy" } };
    const assertFrame = () => {
      assert.equal(render(host.getCallRenderer.call(row)), "native call");
      assert.match(render(host.getResultRenderer.call(row)(result, { expanded: false, isPartial: false }, theme)), new RegExp(expected));
    };

    const cold = installPiHostAdapter(host, createPiToolDisplayResolver({} as any, config), "0.80.3");
    assertFrame();
    cold.dispose();
    const reloaded = installPiHostAdapter(host, createPiToolDisplayResolver({} as any, config), "0.80.3");
    assertFrame();
    assertFrame(); // a new call uses the same live runtime as restored history
    reloaded.dispose();
  }
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
    const diagnostics: any[] = [];
    const runtime = createPiToolDisplayResolver({} as any, () => DEFAULT_TOOL_DISPLAY_CONFIG, diagnostic => diagnostics.push(diagnostic));
    const native = { call: nativeCall, result: nativeResult };
    runtime.resolve({ toolName: "conflict", arguments: {} }, native);
    runtime.resolve({ toolName: "conflict", arguments: {} }, native);
    assert.deepEqual(diagnostics.map(({ kind, adapters }) => ({ kind, adapters })), [{
      kind: "adapter-conflict",
      adapters: [{ id: "first", kind: "generic" }, { id: "second", kind: "mcp" }],
    }]);
    createPiToolDisplayResolver({} as any, () => DEFAULT_TOOL_DISPLAY_CONFIG, diagnostic => diagnostics.push(diagnostic))
      .resolve({ toolName: "conflict", arguments: {} }, native);
    assert.equal(diagnostics.length, 2, "a real reload starts a new diagnostic epoch");

    const failures: any[] = [];
    const broken = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, {
      resolve: (_row, _config, slots) => ({ ...slots, call: () => { throw new Error("call broke"); }, result: () => { throw new Error("result broke"); } }),
    }, diagnostic => failures.push(diagnostic));
    const plan = broken.resolve({ toolName: "broken", arguments: {} }, native);
    plan.call!(); plan.call!(); plan.result!(); plan.result!();
    assert.deepEqual(failures.map(({ kind, toolName, slot }) => ({ kind, toolName, slot })), [
      { kind: "renderer-failure", toolName: "broken", slot: "call" },
      { kind: "renderer-failure", toolName: "broken", slot: "result" },
    ]);
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
