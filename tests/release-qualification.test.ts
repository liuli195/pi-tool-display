import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

import { installPiHostAdapter } from "../src/pi-host-adapter.js";
import { createRendererCatalog } from "../src/renderer-catalog.js";
import { createToolDisplayResolver } from "../src/tool-display-resolver.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.js";

initTheme(undefined, false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: any) => component.render(120).join("\n").trim();
const result = { content: [{ type: "text", text: "one\ntwo" }], details: {} };

function qualifyRows(count: number) {
  const overrides = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`custom-${index}`, { enabled: true, kind: "generic" as const, outputMode: "summary" as const, overrideCallRenderer: false }]));
  const config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, customToolOverrides: overrides };
  const resolver = createToolDisplayResolver(() => config, createRendererCatalog());
  const installation = installPiHostAdapter(ToolExecutionComponent.prototype, resolver, "0.81.1");
  assert.equal(installation.installed, true);

  let snapshotEnumerations = 0;
  let registryGets = 0;
  let rebuilds = 0;
  const entries = Object.entries;
  const mapGet = Map.prototype.get;
  const defineProperty = Object.defineProperty;
  Object.entries = ((value: object) => {
    if (value === overrides) snapshotEnumerations++;
    return entries(value);
  }) as typeof Object.entries;
  Map.prototype.get = function (key: unknown) {
    if (new Error().stack?.includes("renderer-catalog")) registryGets++;
    return mapGet.call(this, key);
  };
  Object.defineProperty = ((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    if (target === ToolExecutionComponent.prototype && (key === "getCallRenderer" || key === "getResultRenderer")) rebuilds++;
    return defineProperty(target, key, descriptor);
  }) as typeof Object.defineProperty;

  const started = performance.now();
  try {
    for (let index = 0; index < count; index++) {
      const row = new ToolExecutionComponent("plain", `call-${index}`, { index }, {}, { name: "plain", execute() {} } as any, { requestRender() {} } as any, process.cwd());
      (row as any).getCallRenderer();
      (row as any).getResultRenderer();
    }
  } finally {
    Object.entries = entries;
    Map.prototype.get = mapGet;
    Object.defineProperty = defineProperty;
    installation.dispose();
  }
  return { elapsed: performance.now() - started, snapshotEnumerations, registryGets, rebuilds };
}

// External instrumentation observes production APIs; there are deliberately no production counters/hooks.
test("production ToolExecution selection performs one snapshot, no row rebuild, and linear registry access", () => {
  const fiveHundred = qualifyRows(500);
  const thousand = qualifyRows(1000);
  assert.deepEqual({ ...fiveHundred, elapsed: 0 }, { elapsed: 0, snapshotEnumerations: 1, registryGets: 1500, rebuilds: 0 });
  assert.deepEqual({ ...thousand, elapsed: 0 }, { elapsed: 0, snapshotEnumerations: 1, registryGets: 3000, rebuilds: 0 });
  assert.ok(thousand.elapsed < fiveHundred.elapsed * 3.5 + 25, `500=${fiveHundred.elapsed.toFixed(1)}ms 1000=${thousand.elapsed.toFixed(1)}ms`);
});

test("config and capability epochs change the first frame from exactly one new immutable snapshot", () => {
  const configured = (outputMode: "summary" | "hidden" | "preview") => ({ custom: { enabled: true, kind: "generic" as const, outputMode, overrideCallRenderer: false } });
  const overrides = configured("summary");
  const summary = { ...DEFAULT_TOOL_DISPLAY_CONFIG, customToolOverrides: overrides };
  const hidden = { ...summary, customToolOverrides: configured("hidden") };
  const preview = { ...summary, customToolOverrides: configured("preview") };
  let effective: ToolDisplayConfig = summary;
  let snapshots = 0;
  const entries = Object.entries;
  Object.entries = ((value: object) => {
    if (value === effective.customToolOverrides) snapshots++;
    return entries(value);
  }) as typeof Object.entries;
  const installation = installPiHostAdapter(ToolExecutionComponent.prototype, createToolDisplayResolver(() => effective, createRendererCatalog()), "0.81.1");
  try {
    const frame = (id: string) => {
      const row = new ToolExecutionComponent("custom", id, {}, {}, { name: "custom", execute() {} } as any, { requestRender() {} } as any, process.cwd());
      return render((row as any).getResultRenderer()(result, { expanded: false, isPartial: false }, theme));
    };
    assert.match(frame("summary"), /2 lines returned/);
    assert.equal(snapshots, 1);
    effective = hidden; // display-config epoch
    assert.equal(frame("hidden"), "");
    assert.equal(snapshots, 2);
    effective = preview; // capability-derived effective-config epoch
    assert.match(frame("preview"), /one[\s\S]*two/);
    assert.equal(snapshots, 3);
    assert.match(frame("same-epoch"), /one[\s\S]*two/);
    assert.equal(snapshots, 3);
  } finally {
    Object.entries = entries;
    installation.dispose();
  }
});

test("unsupported host shape reports one concise diagnostic and preserves native execution", () => {
  let executions = 0;
  const native = () => "native";
  const host = { getCallRenderer() { return native; }, execute() { executions++; return "executed"; } };
  const before = Object.getOwnPropertyDescriptors(host);
  const diagnostics: string[] = [];
  const resolver = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog());

  assert.equal(installPiHostAdapter(host, resolver, "0.81.1", message => diagnostics.push(message)).installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
  assert.equal(host.execute(), "executed");
  assert.equal(executions, 1);
  assert.deepEqual(diagnostics, ["pi-tool-display: unsupported Pi 0.81.1 tool-row renderer shape; using native rendering"]);
});
