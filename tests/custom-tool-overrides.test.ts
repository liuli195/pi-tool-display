import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";

test("normalizeToolDisplayConfig defaults customToolOverrides to an empty opt-in map", () => {
  assert.deepEqual(normalizeToolDisplayConfig({}).customToolOverrides, {});
});

test("normalizeToolDisplayConfig normalizes custom tool override shorthand, defaults, and invalid entries", () => {
  const config = normalizeToolDisplayConfig({ customToolOverrides: {
    ide_find_symbol: true,
    " agent_gateway ": { outputMode: "preview" },
    mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
    disabled_tool: false,
    invalid_kind: { enabled: true, kind: "terminal", outputMode: "verbose" },
    read: { enabled: true, kind: "mcp", outputMode: "summary" },
    "": { enabled: true },
    "   ": true,
  }});
  assert.deepEqual(config.customToolOverrides, {
    ide_find_symbol: { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: false },
    agent_gateway: { enabled: true, kind: "generic", outputMode: "preview", overrideCallRenderer: false },
    mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden", overrideCallRenderer: false },
    disabled_tool: { enabled: false, kind: "generic", outputMode: "summary", overrideCallRenderer: false },
    invalid_kind: { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: false },
  });
});

test("normalizeToolDisplayConfig treats malformed customToolOverrides containers as empty", () => {
  for (const customToolOverrides of [null, true, "ide_find_symbol", [], 42])
    assert.deepEqual(normalizeToolDisplayConfig({ customToolOverrides }).customToolOverrides, {});
});

test("normalizeToolDisplayConfig preserves supported custom output modes and drops unknown entry fields", () => {
  const config = normalizeToolDisplayConfig({ customToolOverrides: {
    hidden_tool: { enabled: true, outputMode: "hidden", label: "Ignored Label" },
    summary_tool: { enabled: true, outputMode: "summary", pathFields: ["file_path"] },
    preview_tool: { enabled: true, outputMode: "preview", renderShell: "self", overrideCallRenderer: true },
  }});
  assert.deepEqual(config.customToolOverrides, {
    hidden_tool: { enabled: true, kind: "generic", outputMode: "hidden", overrideCallRenderer: false },
    summary_tool: { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: false },
    preview_tool: { enabled: true, kind: "generic", outputMode: "preview", overrideCallRenderer: true },
  });
});
