import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { registerToolExecutionPatch } from "../src/tool-execution-patch.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

initTheme(undefined, false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: unknown) => (component as { render(width: number): string[] }).render(120).join("\n").trim();
const plainRender = (component: unknown) => render(component).replace(/\x1b\[[0-9;]*m/g, "");
const result = { content: [{ type: "text", text: "one\ntwo" }], details: {} };
const options = { expanded: false, isPartial: false };

function config(customToolOverrides: Record<string, unknown>): ToolDisplayConfig {
  return { ...DEFAULT_TOOL_DISPLAY_CONFIG, customToolOverrides } as ToolDisplayConfig;
}

function apiStub() {
  const handlers: Record<string, (event?: unknown) => unknown> = {};
  return {
    api: { on: (event: string, handler: (event?: unknown) => unknown) => { handlers[event] = handler; } } as unknown as ExtensionAPI,
    handlers,
  };
}

function component(toolDefinition: Record<string, unknown>, builtInToolDefinition?: Record<string, unknown>): any {
  return Object.assign(Object.create(ToolExecutionComponent.prototype), { toolDefinition, builtInToolDefinition });
}

test("configured third-party tools preserve native calls and override results at final renderer selection", () => {
  const { api, handlers } = apiStub();
  const instance = component({
    name: "ordinary_tool",
    renderCall: () => ({ render: () => ["original call"] }),
    renderResult: () => ({ render: () => ["original result"] }),
  });
  registerToolExecutionPatch(api, () => config({ ordinary_tool: { enabled: true, kind: "generic", outputMode: "summary" } }));
  try {
    assert.equal(render(instance.getCallRenderer()({ value: 1 }, theme)), "original call");
    assert.equal(render(instance.getResultRenderer()(result, options, theme)), "↳ 2 lines returned • Ctrl+O to expand");
  } finally {
    handlers.session_shutdown?.({ reason: "reload" });
  }
});

test("overrideCallRenderer opts into replacing a third-party call renderer", () => {
  const { api, handlers } = apiStub();
  const instance = component({
    name: "ordinary_tool",
    renderCall: () => ({ render: () => ["original call"] }),
  });
  registerToolExecutionPatch(api, () => config({
    ordinary_tool: { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: true },
  }));
  try {
    assert.equal(render(instance.getCallRenderer()({ value: 1 }, theme)), "ordinary_tool (1 arg)");
  } finally {
    handlers.session_shutdown?.({ reason: "reload" });
  }
});

test("MCP proxy and direct tools use only ordinary custom override configuration", () => {
  const { api, handlers } = apiStub();
  registerToolExecutionPatch(api, () => config({
    mcp: { enabled: true, kind: "mcp", outputMode: "summary" },
    xcodebuild_list_sims: { enabled: true, kind: "mcp", outputMode: "hidden" },
  }));
  try {
    const proxy = component({ name: "mcp" });
    const direct = component({ name: "xcodebuild_list_sims", label: "MCP xcodebuild_list_sims" });
    assert.equal(render(proxy.getCallRenderer()({ tool: "read_file", server: "fs" }, theme)), "MCP call fs:read_file (2 args)");
    assert.equal(render(direct.getCallRenderer()({}, theme)), "MCP xcodebuild_list_sims (no args)");
    assert.equal(render(direct.getResultRenderer()(result, options, theme)), "");
  } finally {
    handlers.session_shutdown?.({ reason: "reload" });
  }
});

test("unconfigured third-party and built-in tools retain their original renderers", () => {
  const { api, handlers } = apiStub();
  registerToolExecutionPatch(api, () => config({ read: true, configured: true }));
  try {
    const originalCall = () => ({ render: () => ["original call"] });
    const originalResult = () => ({ render: () => ["original result"] });
    const unconfigured = component({ name: "unconfigured", renderCall: originalCall, renderResult: originalResult });
    const builtIn = component(
      { name: "read", renderCall: originalCall, renderResult: originalResult },
      { name: "read", renderCall: originalCall, renderResult: originalResult },
    );
    assert.equal(unconfigured.getCallRenderer(), originalCall);
    assert.equal(unconfigured.getResultRenderer(), originalResult);
    assert.equal(builtIn.getCallRenderer(), originalCall);
    assert.equal(builtIn.getResultRenderer(), originalResult);
  } finally {
    handlers.session_shutdown?.({ reason: "reload" });
  }
});

test("historical built-in rows redraw through current renderers while third-party provenance wins", async () => {
  const makeRuntime = (outputMode: "preview" | "summary") => {
    const handlers: Record<string, (event?: unknown) => unknown> = {};
    const registered: Record<string, unknown>[] = [];
    let owners: Record<string, unknown>[] = [];
    const api = {
      on: (event: string, handler: (event?: unknown) => unknown) => { handlers[event] = handler; },
      getActiveTools: () => ["bash", "edit"],
      getAllTools: () => owners,
      registerTool: (tool: Record<string, unknown>) => {
        registered.push(tool);
        owners = [
          ...owners.filter((owner) => owner.name !== tool.name),
          { name: tool.name, sourceInfo: { source: "local", path: "pi-tool-display.ts" } },
        ];
      },
    } as unknown as ExtensionAPI;
    const currentConfig = {
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      bashOutputMode: outputMode,
      diffViewMode: "unified" as const,
      diffCollapsedLines: outputMode === "summary" ? 1 : 24,
    };
    registerToolDisplayOverrides(api, () => currentConfig);
    registerToolExecutionPatch(api, () => currentConfig);
    return { api, handlers, registered, setOwners: (next: Record<string, unknown>[]) => { owners = next; } };
  };
  const ui = { requestRender() {} } as any;

  const first = makeRuntime("preview");
  await first.handlers.session_start?.();
  const oldDefinition = first.registered.find((tool) => tool.name === "bash") as any;
  const oldEditDefinition = first.registered.find((tool) => tool.name === "edit") as any;
  const historical = new ToolExecutionComponent("bash", "old-call", { command: "printf one" }, {}, oldDefinition, ui, process.cwd());
  historical.updateResult({ ...result, isError: false });
  const historicalEdit = new ToolExecutionComponent("edit", "old-edit", { path: "file.ts", edits: [] }, {}, oldEditDefinition, ui, process.cwd());
  historicalEdit.updateResult({
    content: [{ type: "text", text: "Done" }],
    details: { diff: "@@ -1,3 +1,3 @@\n-old one\n-old two\n-old three\n+new one\n+new two\n+new three" },
    isError: false,
  });
  first.handlers.session_shutdown?.({ reason: "reload" });
  disposeAll();
  resetDisposed();

  const second = makeRuntime("summary");
  await second.handlers.session_start?.();
  try {
    delete oldDefinition.name;
    historical.setExpanded(false);
    assert.match(plainRender(historical), /↳ 2 lines returned .*Ctrl\+O to expand/);
    historical.setExpanded(true);
    assert.match(plainRender(historical), /one\s+two/);
    historical.setExpanded(false);
    assert.match(plainRender(historical), /↳ 2 lines returned .*Ctrl\+O to expand/);
    historicalEdit.setExpanded(false);
    assert.doesNotMatch(plainRender(historicalEdit), /new three/);
    historicalEdit.setExpanded(true);
    assert.match(plainRender(historicalEdit), /new three/);
    historicalEdit.setExpanded(false);
    assert.doesNotMatch(plainRender(historicalEdit), /new three/);

    const thirdPartyDefinition = {
      name: "bash",
      renderCall: () => ({ render: () => ["third-party bash"] }),
      renderResult: () => ({ render: () => ["third-party result"] }),
    } as any;
    const thirdPartyRow = new ToolExecutionComponent("bash", "third-party-call", {}, {}, thirdPartyDefinition, ui, process.cwd());
    thirdPartyRow.updateResult({ ...result, isError: false });
    thirdPartyRow.setExpanded(false);
    assert.match(plainRender(thirdPartyRow), /third-party bash/);
    assert.match(plainRender(thirdPartyRow), /third-party result/);

    second.setOwners([{ name: "bash", sourceInfo: { source: "local", path: "third-party.ts" } }]);
    historical.setExpanded(false);
    assert.doesNotMatch(plainRender(historical), /↳ 2 lines returned .*Ctrl\+O to expand/);
  } finally {
    second.handlers.session_shutdown?.({ reason: "reload" });
    disposeAll();
    resetDisposed();
  }
});

test("failed built-in registration does not publish a renderer", async () => {
  const handlers: Record<string, (event?: unknown) => unknown> = {};
  const api = {
    on: (event: string, handler: (event?: unknown) => unknown) => { handlers[event] = handler; },
    getActiveTools: () => ["bash"],
    getAllTools: () => [],
    registerTool: () => { throw new Error("registration failed"); },
  } as unknown as ExtensionAPI;
  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  registerToolExecutionPatch(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  await assert.rejects(async () => handlers.session_start?.(), /registration failed/);

  const historical = component({ name: "bash", renderCall: () => ({ render: () => ["old built-in"] }) }, { name: "bash" });
  assert.equal(render(historical.getCallRenderer()({}, theme)), "old built-in");
  handlers.session_shutdown?.({ reason: "reload" });
  disposeAll();
  resetDisposed();
});

test("reload restores the prototype and reinstallation does not stack wrappers", () => {
  const prototype = ToolExecutionComponent.prototype as any;
  const originalCall = prototype.getCallRenderer;
  const originalResult = prototype.getResultRenderer;
  const first = apiStub();
  registerToolExecutionPatch(first.api, () => config({ configured: true }));
  const firstPatchedCall = prototype.getCallRenderer;
  registerToolExecutionPatch(first.api, () => config({ configured: true }));
  assert.equal(prototype.getCallRenderer, firstPatchedCall);
  first.handlers.session_shutdown?.({ reason: "reload" });
  assert.equal(prototype.getCallRenderer, originalCall);
  assert.equal(prototype.getResultRenderer, originalResult);

  const second = apiStub();
  registerToolExecutionPatch(second.api, () => config({ configured: true }));
  assert.notEqual(prototype.getCallRenderer, originalCall);
  second.handlers.session_shutdown?.({ reason: "reload" });
  assert.equal(prototype.getCallRenderer, originalCall);
});
