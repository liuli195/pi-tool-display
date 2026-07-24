import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog, registerProducerRendererAdapter } from "../src/renderer-catalog.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { registerToolDisplayApi } from "../src/tool-overrides.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { registerRendererAdapter } from "../tool-display-api-consumer.js";

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

test("an explicit disabled custom override keeps native presentation ahead of producer intent", () => {
  const dispose = registerProducerRendererAdapter({ id: "producer-disabled", toolName: "third_party", kind: "generic" });
  try {
    const config = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      customToolOverrides: {
        third_party: { enabled: false, kind: "generic" as const, outputMode: "preview" as const, overrideCallRenderer: true },
      },
    };
    assert.equal(createRendererCatalog().resolve(row, config, {}), undefined);
  } finally { dispose(); }
});

test("producer callbacks receive detached arguments, results, and context args", () => {
  const args = { nested: { path: "original.txt" } };
  const result = { content: [{ type: "text", text: "original" }], details: { count: 1 } };
  const context = { args, state: {} };
  const dispose = registerProducerRendererAdapter({
    id: "mutating-producer",
    toolName: "third_party",
    kind: "generic",
    overrideCallRenderer: true,
    renderCall(received: typeof args, _theme: unknown, receivedContext: typeof context) {
      received.nested.path = "changed.txt";
      receivedContext.args.nested.path = "changed-again.txt";
      return { render: () => ["call"] };
    },
    renderResult(received: typeof result) {
      received.content[0].text = "changed";
      received.details.count = 2;
      return { render: () => ["result"] };
    },
  });
  try {
    const plan = createRendererCatalog().resolve(
      { ...row, arguments: args },
      DEFAULT_TOOL_DISPLAY_CONFIG,
      {},
    )!;
    plan.call!(args, {}, context);
    plan.result!(result, {}, {}, context);
    assert.deepEqual(args, { nested: { path: "original.txt" } });
    assert.deepEqual(result, { content: [{ type: "text", text: "original" }], details: { count: 1 } });
    assert.strictEqual(context.args, args);
  } finally { dispose(); }
});

test("uncloneable producer data falls back without invoking the callback", () => {
  let invoked = false;
  const dispose = registerProducerRendererAdapter({
    id: "clone-failure",
    toolName: "third_party",
    kind: "generic",
    renderResult() { invoked = true; },
  });
  try {
    const nativeResult = () => ({ render: () => ["native"] });
    const plan = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog())
      .resolve(row, { result: nativeResult });
    assert.deepEqual(plan.result!({ details: { callback() {} } }, {}, {}).render(), ["native"]);
    assert.equal(invoked, false);
  } finally { dispose(); }
});

test("equal-priority producer conflicts fail deterministically regardless of order", () => {
  const first = registerProducerRendererAdapter({ id: "z", toolName: "third_party", kind: "generic" });
  const second = registerProducerRendererAdapter({ id: "a", toolName: "third_party", kind: "mcp" });
  try {
    assert.throws(() => createRendererCatalog().resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}), /a \(mcp\), z \(generic\)/);
  } finally { second(); first(); }
});

test("early producer registration preserves modern output and call-override fields", () => {
  resetDisposed();
  const apiSymbol = Symbol.for("pi-tool-display.api.v1");
  delete (globalThis as any)[apiSymbol];
  const disposePending = registerRendererAdapter({
    id: "early-modern",
    toolName: "early_modern",
    kind: "generic",
    outputMode: "hidden",
    overrideCallRenderer: true,
  });
  try {
    registerToolDisplayApi(() => DEFAULT_TOOL_DISPLAY_CONFIG);
    const nativeCall = () => ({ render: () => ["native call"] });
    const plan = createRendererCatalog().resolve(
      { toolName: "early_modern", arguments: {}, builtIn: false },
      DEFAULT_TOOL_DISPLAY_CONFIG,
      { call: nativeCall },
    )!;
    assert.notStrictEqual(plan.call, nativeCall);
    assert.deepEqual(plan.result!({ content: [{ type: "text", text: "secret" }] }, { expanded: false }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }).render(80), []);
  } finally {
    disposePending();
    disposeAll();
  }
});

test("reused global API keeps producer intent and remains disposable by the current epoch", () => {
  resetDisposed();
  registerToolDisplayApi(() => DEFAULT_TOOL_DISPLAY_CONFIG);
  const apiSymbol = Symbol.for("pi-tool-display.api.v1");
  const api = (globalThis as any)[apiSymbol];
  api.registerAdapter({ id: "epoch-producer", toolName: "epoch_tool", kind: "generic" });
  registerToolDisplayApi(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 1 }));
  assert.strictEqual((globalThis as any)[apiSymbol], api);
  assert.ok(createRendererCatalog().resolve({ toolName: "epoch_tool", arguments: {} }, DEFAULT_TOOL_DISPLAY_CONFIG, {}));

  disposeAll();
  assert.equal((globalThis as any)[apiSymbol], undefined);
  assert.equal(createRendererCatalog().resolve({ toolName: "epoch_tool", arguments: {} }, DEFAULT_TOOL_DISPLAY_CONFIG, {}), undefined);
});

test("legacy read and edit adapter kinds retain their specialized display without mutating definitions", () => {
  resetDisposed();
  const read = Object.freeze({ name: "legacy_read", execute: Object.freeze(() => undefined) });
  const edit = Object.freeze({ name: "legacy_edit", execute: Object.freeze(() => undefined) });
  const config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, readOutputMode: "summary" as const };
  try {
    registerToolDisplayApi(() => config);
    const api = (globalThis as any)[Symbol.for("pi-tool-display.api.v1")];
    assert.strictEqual(api.decorateTool(read, { kind: "read", pathFields: ["target"] }), read);
    assert.strictEqual(api.decorateTool(edit, { kind: "edit", pathFields: ["target"] }), edit);

    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const readPlan = createRendererCatalog().resolve({ toolName: "legacy_read", arguments: { target: "folder/file.txt", offset: 2, limit: 3 } }, config, {});
    assert.match(readPlan!.call!({ target: "folder/file.txt", offset: 2, limit: 3 }, theme).render(120).join("\n"), /read.*folder[\\/]file\.txt:2-4/);
    assert.match(readPlan!.result!({ content: [{ type: "text", text: "one\ntwo" }] }, { expanded: false }, theme).render(120).join("\n"), /loaded 2 lines/);

    const editPlan = createRendererCatalog().resolve({ toolName: "legacy_edit", arguments: { target: "folder/file.txt", oldText: "old", newText: "new" } }, config, {});
    assert.match(editPlan!.call!({ target: "folder/file.txt", oldText: "old", newText: "new" }, theme, {}).render(120).join("\n"), /edit.*folder[\\/]file\.txt.*1 line/);
    assert.match(editPlan!.result!({ content: [{ type: "text", text: "Edited" }] }, { expanded: false }, theme, { args: { target: "folder/file.txt", oldText: "old", newText: "new" } }).render(120).join("\n"), /Edited/);
    assert.equal(read.execute(), undefined);
    assert.equal(edit.execute(), undefined);
  } finally { disposeAll(); }
});
