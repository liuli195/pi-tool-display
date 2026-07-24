import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { installPiHostAdapter } from "../src/pi-host-adapter.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any, width = 120) => component.render(width).join("\n");
const output = (text: string, details: object = {}) => ({ content: [{ type: "text", text }], details });
const resolver = (overrides = {}) => createToolDisplayResolver(
  () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays, bash: true }, ...overrides }),
  createRendererCatalog(),
);

test("Bash resolves call and independently folded success/error results from original row data", () => {
  const nativeCall = () => ({ render: () => ["native call"] });
  const nativeResult = () => ({ render: () => ["native result"] });
  const plan = resolver({
    bashCommandMode: "summary", bashOutputMode: "summary", bashErrorOutputMode: "preview", bashErrorPreviewLines: 1,
  }).resolve({ toolName: "bash", arguments: { command: "echo " + "word ".repeat(30) }, builtIn: true }, { call: nativeCall, result: nativeResult });

  assert.notStrictEqual(plan.call, nativeCall);
  assert.notStrictEqual(plan.result, nativeResult);
  assert.match(render(plan.call!({ command: "echo " + "word ".repeat(30) }, theme, { executionStarted: false, isPartial: false }), 30), /more visual lines/);
  assert.match(render(plan.result!(output("alpha\nbeta\ngamma"), { expanded: false, isPartial: false }, theme, { args: { command: "echo ok" } })), /3 lines returned/);
  assert.match(render(plan.result!(output("failure detail that wraps across the terminal width"), { expanded: false, isPartial: false }, theme, { args: { command: "false" }, isError: true }), 20), /command failed[\s\S]*more visua/);
});

test("Bash partial, empty, truncation, and expanded output retain presentation behavior", () => {
  const plan = resolver({ bashOutputMode: "preview", previewLines: 1, showTruncationHints: true })
    .resolve({ toolName: "bash", arguments: { command: "printf x" }, builtIn: true }, {});
  assert.equal(render(plan.result!(output(""), { expanded: false, isPartial: true }, theme, {})), "");
  assert.match(render(plan.result!(output("first\nsecond"), { expanded: false, isPartial: true }, theme, {})), /first[\s\S]*more line/);
  assert.match(render(plan.result!(output("", { truncation: { truncated: true }, fullOutputPath: "/tmp/full" }), { expanded: false, isPartial: false }, theme, { args: { command: "true" } })), /no output[\s\S]*truncated[\s\S]*full output/);
  assert.match(render(plan.result!(output("first\nsecond"), { expanded: true, isPartial: false }, theme, {})), /second/);
});

test("Bash Host Adapter changes only renderer selection and does not stack on reload", () => {
  const originalCall = function () { return function () { return { render: () => ["native call"] }; }; };
  const originalResult = function () { return function () { return { render: () => ["native result"] }; }; };
  const host: any = {};
  Object.defineProperties(host, {
    getCallRenderer: { value: originalCall, writable: true, configurable: true },
    getResultRenderer: { value: originalResult, writable: true, configurable: true },
  });
  const definition = Object.freeze({ name: "bash", execute() {}, marker: {} });
  const row = { toolName: "bash", args: { command: "echo ok" }, toolDefinition: definition, builtInToolDefinition: definition };
  const pristine = Object.getOwnPropertyDescriptors(definition);

  const first = installPiHostAdapter(host, resolver(), "0.80.3");
  const patchedCall = host.getCallRenderer;
  const second = installPiHostAdapter(host, resolver(), "0.80.3");
  assert.strictEqual(host.getCallRenderer, patchedCall);
  assert.match(render(host.getCallRenderer.call(row)!(row.args, theme, { executionStarted: false, isPartial: false })), /echo ok/);
  assert.deepEqual(Object.getOwnPropertyDescriptors(definition), pristine);
  second.dispose();
  assert.strictEqual(host.getCallRenderer, originalCall);
  assert.strictEqual(host.getResultRenderer, originalResult);
  first.dispose();
});
