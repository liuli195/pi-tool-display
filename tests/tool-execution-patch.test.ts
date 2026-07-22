import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolExecutionPatch } from "../src/tool-execution-patch.ts";
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

test("configured third-party tools are overridden at final renderer selection", () => {
  const { api, handlers } = apiStub();
  const instance = component({
    name: "ordinary_tool",
    renderCall: () => ({ render: () => ["original call"] }),
    renderResult: () => ({ render: () => ["original result"] }),
  });
  registerToolExecutionPatch(api, () => config({ ordinary_tool: { enabled: true, kind: "generic", outputMode: "summary" } }));
  try {
    assert.equal(render(instance.getCallRenderer()({ value: 1 }, theme)), "ordinary_tool (1 arg)");
    assert.equal(render(instance.getResultRenderer()(result, options, theme)), "↳ 2 lines returned • Ctrl+O to expand");
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
