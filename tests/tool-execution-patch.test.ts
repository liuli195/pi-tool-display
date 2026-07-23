import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeAll } from "../src/disposable.ts";
import { registerToolExecutionPatch } from "../src/tool-execution-patch.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const render = (component: unknown) => (component as { render(width: number): string[] }).render(120).join("\n").trim();
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

test("historical components resolve current built-in renderers after reload without replacing third-party owners", async () => {
  const oldBash = component({
    name: "bash",
    renderCall: () => ({ render: () => ["old bash call"] }),
    renderResult: () => ({ render: () => ["old bash result"] }),
  }, { name: "bash" });
  const oldEdit = component({
    name: "edit",
    renderResult: () => ({ render: () => ["old edit result"] }),
  }, { name: "edit" });
  const first = apiStub();
  registerToolExecutionPatch(first.api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  first.handlers.session_shutdown?.({ reason: "reload" });

  const handlers: Record<string, (event?: unknown) => unknown> = {};
  const registered: Record<string, unknown>[] = [];
  const api = {
    on: (event: string, handler: (event?: unknown) => unknown) => { handlers[event] = handler; },
    getActiveTools: () => ["bash", "edit"],
    getAllTools: () => [],
    registerTool: (tool: Record<string, unknown>) => { registered.push(tool); },
  } as unknown as ExtensionAPI;
  const currentConfig = {
    ...DEFAULT_TOOL_DISPLAY_CONFIG,
    bashCommandMode: "summary" as const,
    bashOutputMode: "summary" as const,
    diffViewMode: "unified" as const,
  };
  registerToolDisplayOverrides(api, () => currentConfig);
  registerToolExecutionPatch(api, () => currentConfig);
  await handlers.session_start?.();

  try {
    assert.deepEqual(registered.map((tool) => tool.name).sort(), ["bash", "edit"]);
    assert.equal(render(oldBash.getCallRenderer()({ command: "printf one" }, theme, {})), "$ printf one");
    assert.equal(render(oldBash.getResultRenderer()(result, options, theme, { args: { command: "printf one" } })), "↳ 2 lines returned • Ctrl+O to expand");
    assert.match(render(oldBash.getResultRenderer()(result, { ...options, expanded: true }, theme, { args: { command: "printf one" } })), /^one\s*\ntwo$/);
    assert.equal(render(oldBash.getResultRenderer()(result, options, theme, { args: { command: "printf one" } })), "↳ 2 lines returned • Ctrl+O to expand");
    assert.notEqual(render(oldEdit.getResultRenderer()(result, options, theme, { args: { path: "file.ts", edits: [] } })), "old edit result");
  } finally {
    handlers.session_shutdown?.({ reason: "reload" });
    disposeAll();
  }

  const thirdParty = component({
    name: "bash",
    renderCall: () => ({ render: () => ["third-party bash"] }),
  }, { name: "bash" });
  const external = apiStub();
  const externalApi = {
    ...external.api,
    getActiveTools: () => ["bash"],
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "local", path: "third-party.ts" } }],
    registerTool: () => assert.fail("must not register over a third-party owner"),
  } as unknown as ExtensionAPI;
  registerToolDisplayOverrides(externalApi, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  registerToolExecutionPatch(externalApi, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  await external.handlers.session_start?.();
  try {
    assert.equal(render(thirdParty.getCallRenderer()({}, theme)), "third-party bash");
  } finally {
    external.handlers.session_shutdown?.({ reason: "reload" });
  }
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
