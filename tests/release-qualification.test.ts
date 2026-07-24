import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

import { installPiHostAdapter } from "../src/pi-host-adapter.js";
import { createRendererCatalog, type DisplayPerformanceObserver } from "../src/renderer-catalog.js";
import { createToolDisplayResolver } from "../src/tool-display-resolver.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.js";

initTheme(undefined, false);
const native = () => "native";

function qualifyRows(count: number) {
  const metrics = { snapshotBuilds: 0, catalogLookups: 0, producerRegistryScans: 0, hostRebuilds: 0 };
  const observer: DisplayPerformanceObserver = {
    snapshotBuilt: () => { metrics.snapshotBuilds++; },
    catalogLookup: () => { metrics.catalogLookups++; },
    producerRegistryScanned: () => { metrics.producerRegistryScans++; },
    hostRebuilt: () => { metrics.hostRebuilds++; },
  };
  const config = {
    ...DEFAULT_TOOL_DISPLAY_CONFIG,
    customToolOverrides: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`custom-${index}`, { enabled: true, kind: "generic" as const, outputMode: "summary" as const, overrideCallRenderer: false }])),
  };
  const resolver = createToolDisplayResolver(() => config, createRendererCatalog(undefined, observer), undefined, observer);
  const installation = installPiHostAdapter(ToolExecutionComponent.prototype, resolver, "0.81.1", undefined, observer);
  assert.equal(installation.installed, true);
  try {
    for (let index = 0; index < count; index++) {
      new ToolExecutionComponent("plain", `call-${index}`, { index }, {}, { name: "plain", execute() {} } as any, { requestRender() {} } as any, process.cwd());
    }
  } finally { installation.dispose(); }
  return metrics;
}

test("real ToolExecution production seam resolves 500 rows from one immutable epoch snapshot in O(1) each", () => {
  assert.deepEqual(qualifyRows(500), { snapshotBuilds: 1, catalogLookups: 500, producerRegistryScans: 0, hostRebuilds: 1 });
});

test("real ToolExecution selection scales linearly from 500 to 1000 rows", () => {
  const fiveHundred = qualifyRows(500);
  const thousand = qualifyRows(1000);
  assert.equal(thousand.snapshotBuilds, fiveHundred.snapshotBuilds);
  assert.equal(thousand.hostRebuilds, fiveHundred.hostRebuilds);
  assert.equal(thousand.producerRegistryScans, 0);
  assert.equal(thousand.catalogLookups, fiveHundred.catalogLookups * 2);
});

test("unsupported host shape reports one concise diagnostic and preserves native execution", () => {
  let executions = 0;
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
