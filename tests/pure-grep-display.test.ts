import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { installPiHostAdapter } from "../src/pi-host-adapter.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const output = { content: [{ type: "text", text: "a:1\nb:2\nc:3" }], details: {} };
const render = (value: any) => value.render(120).join("\n");
const config = (mode: "hidden" | "count" | "preview") =>
  createToolDisplayResolver(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, searchOutputMode: mode }), createRendererCatalog());

function syntheticHost() {
  const calls: Array<{ receiver: unknown; args: unknown[]; slot: string }> = [];
  const nativeCall = function (this: unknown, ...args: unknown[]) {
    calls.push({ receiver: this, args, slot: "call" });
    return function (this: unknown, ...rendererArgs: unknown[]) { return { receiver: this, rendererArgs, render: () => ["native call"] }; };
  };
  const nativeResult = function (this: unknown, ...args: unknown[]) {
    calls.push({ receiver: this, args, slot: "result" });
    return function (this: unknown, ...rendererArgs: unknown[]) { return { receiver: this, rendererArgs, render: () => ["native result"] }; };
  };
  const host = {} as any;
  Object.defineProperties(host, {
    getCallRenderer: { value: nativeCall, writable: true, configurable: true, enumerable: false },
    getResultRenderer: { value: nativeResult, writable: true, configurable: true, enumerable: true },
  });
  return { host, calls };
}

test("grep modes and renderer failures fail open without vacuous hidden assertions", () => {
  const native = function () { return { render: () => ["native"] }; };
  const hidden = config("hidden").resolve({ toolName: "grep", arguments: { pattern: "x" } }, { result: native });
  assert.equal(render(hidden.result!(output, { expanded: false, isPartial: false }, theme)), "");
  assert.equal(render(hidden.result!(output, { expanded: true, isPartial: false }, theme)), "");

  for (const [mode, collapsed, expanded] of [["count", "3 matches", "c:3"], ["preview", "a:1", "c:3"]] as const) {
    const plan = config(mode).resolve({ toolName: "grep", arguments: { pattern: "x" } }, { result: native });
    assert.match(render(plan.result!(output, { expanded: false, isPartial: false }, theme)), new RegExp(collapsed));
    assert.match(render(plan.result!(output, { expanded: true, isPartial: false }, theme)), new RegExp(expanded));
  }
  assert.strictEqual(config("count").resolve({ toolName: "other", arguments: {} }, { result: native }).result, native);
  const failed = createToolDisplayResolver(() => { throw new Error("bad config"); }, createRendererCatalog());
  assert.strictEqual(failed.resolve({ toolName: "grep", arguments: {} }, { result: native }).result, native);

  const customThis = { custom: true };
  let customReceiver: unknown;
  let nativeReceiver: unknown;
  const brokenRenderer = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, {
    resolve: (_row, _config, slots) => ({
      ...slots,
      result: function (this: unknown, ...args: unknown[]) { customReceiver = this; assert.deepEqual(args, ["payload"]); throw new Error("broken"); },
    }),
  });
  const fallback = function (this: unknown, ...args: unknown[]) { nativeReceiver = this; assert.deepEqual(args, ["payload"]); return "native"; };
  const wrapper = brokenRenderer.resolve({ toolName: "grep", arguments: {} }, { result: fallback }).result!;
  assert.equal(wrapper.apply(customThis, ["payload"]), "native");
  assert.strictEqual(customReceiver, customThis);
  assert.strictEqual(nativeReceiver, customThis);
});

test("Pi Host Adapter is transactional, idempotent, receiver-safe, and conflict-safe on a synthetic host", () => {
  const { host, calls } = syntheticHost();
  const pristine = Object.getOwnPropertyDescriptors(host);
  let installation: ReturnType<typeof installPiHostAdapter> | undefined;
  try {
    installation = installPiHostAdapter(host, config("count"), "0.80.3");
    assert.equal(installation.installed, true);
    const installed = Object.getOwnPropertyDescriptors(host);
    assert.notStrictEqual(installed.getCallRenderer.value, pristine.getCallRenderer.value);
    assert.notStrictEqual(installed.getResultRenderer.value, pristine.getResultRenderer.value);

    const row = { toolName: "other", args: {}, toolDefinition: { name: "other" } };
    const callSelectorArgs = ["call-selector-arg"];
    const resultSelectorArgs = ["result-selector-arg"];
    const callRenderer = host.getCallRenderer.apply(row, callSelectorArgs);
    const resultRenderer = host.getResultRenderer.apply(row, resultSelectorArgs);
    assert.deepEqual(calls, [
      { receiver: row, args: callSelectorArgs, slot: "call" },
      { receiver: row, args: resultSelectorArgs, slot: "result" },
    ]);
    const rendererReceiver = { renderer: true };
    assert.strictEqual(callRenderer.apply(rendererReceiver, [1]).receiver, rendererReceiver);
    assert.strictEqual(resultRenderer.apply(rendererReceiver, [2]).receiver, rendererReceiver);

    const second = installPiHostAdapter(host, config("preview"), "0.80.3");
    assert.equal(second.installed, true);
    assert.strictEqual(host.getResultRenderer, installed.getResultRenderer.value);

    const foreign = function () { return "foreign"; };
    const foreignDescriptor = { ...installed.getResultRenderer, value: foreign };
    Object.defineProperty(host, "getResultRenderer", foreignDescriptor);
    second.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(host, "getCallRenderer"), pristine.getCallRenderer);
    assert.deepEqual(Object.getOwnPropertyDescriptor(host, "getResultRenderer"), foreignDescriptor);
    assert.strictEqual(host.getResultRenderer, foreign);
    assert.notStrictEqual(host.getCallRenderer, installed.getCallRenderer.value);
    installation = undefined;
  } finally {
    installation?.dispose();
  }
});

test("Pi Host Adapter retains ownership tracking until an interrupted mixed disposal can finish", () => {
  const target = syntheticHost().host;
  const pristineCall = Object.getOwnPropertyDescriptor(target, "getCallRenderer")!;
  let blockCallRestore = false;
  const host = new Proxy(target, {
    defineProperty(object, property, descriptor) {
      if (property === "getCallRenderer" && blockCallRestore && descriptor.value === pristineCall.value) throw new Error("blocked restore");
      return Reflect.defineProperty(object, property, descriptor);
    },
  });
  const installation = installPiHostAdapter(host, config("count"), "0.80.3");
  assert.equal(installation.installed, true);
  const patchedCall = target.getCallRenderer;
  const foreignResult = function () { return "foreign"; };
  target.getResultRenderer = foreignResult;
  blockCallRestore = true;
  installation.dispose();
  assert.strictEqual(target.getCallRenderer, patchedCall);
  assert.strictEqual(target.getResultRenderer, foreignResult);
  assert.equal(installPiHostAdapter(host, config("count"), "0.80.3").installed, false);
  blockCallRestore = false;
  installation.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, "getCallRenderer"), pristineCall);
  assert.strictEqual(target.getResultRenderer, foreignResult);
});

test("Pi Host Adapter accepts stable Pi versions from 0.81.1 onward", () => {
  for (const version of ["0.81.1", "0.82.0", "1.0.0"]) {
    const { host } = syntheticHost();
    const installation = installPiHostAdapter(host, config("count"), version);
    assert.equal(installation.installed, true);
    installation.dispose();
  }
});

test("Pi Host Adapter rejects unsupported and non-extensible hosts without descriptor changes", () => {
  for (const [host, version] of [
    [Object.preventExtensions(syntheticHost().host), "0.80.3"],
    [syntheticHost().host, "0.81.0"],
    [syntheticHost().host, "0.82.0-beta.1"],
    [{ getCallRenderer() {} }, "0.80.3"],
  ] as const) {
    const before = Object.getOwnPropertyDescriptors(host);
    assert.equal(installPiHostAdapter(host, config("count"), version).installed, false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
  }
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("hostile shape"); } });
  assert.equal(installPiHostAdapter(hostile, config("count"), "0.80.3").installed, false);
});

test("Pi Host Adapter rolls back exact descriptors when a patch step fails", () => {
  const target = syntheticHost().host;
  const pristine = Object.getOwnPropertyDescriptors(target);
  let failResultPatch = true;
  const host = new Proxy(target, {
    defineProperty(object, property, descriptor) {
      if (property === "getResultRenderer" && failResultPatch && descriptor.value !== pristine.getResultRenderer.value) {
        failResultPatch = false;
        throw new Error("blocked result patch");
      }
      return Reflect.defineProperty(object, property, descriptor);
    },
  });
  assert.equal(installPiHostAdapter(host, config("count"), "0.80.3").installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(target), pristine);
});
