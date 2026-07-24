import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const result = (text: string, details: object = {}) => ({ content: [{ type: "text", text }], details });
const options = (expanded = false, isPartial = false) => ({ expanded, isPartial });

function resolveResult(toolName: string, config: Partial<ToolDisplayConfig>, arguments_: Record<string, unknown> = {}, builtIn = true) {
  return createToolDisplayResolver(
    () => ({
      ...DEFAULT_TOOL_DISPLAY_CONFIG,
      ...config,
      builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays, ...config.builtInToolDisplays },
    }),
    createRendererCatalog(),
  ).resolve({ toolName, arguments: arguments_, builtIn }, {}).result!;
}

function assertWidthSafe(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
}

test("Bash success preview budgets complete text by visual lines", () => {
  const renderResult = resolveResult("bash", { bashOutputMode: "preview", previewLines: 1 }, { command: "printf" });
  const lines = renderResult(result("123456789012345\nb\nc"), options(), theme, { args: { command: "printf" } }).render(10);

  assert.deepEqual(lines, ["1234567890", "… (+3)"]);
  assertWidthSafe(lines, 10);
});

test("expanded Bash error preview caps complete text by visual lines", () => {
  const renderResult = resolveResult("bash", { bashErrorOutputMode: "preview", expandedPreviewMaxLines: 1 }, { command: "false" });
  const lines = renderResult(result("123456789012345\nb\nc"), options(true), theme, { args: { command: "false" }, isError: true }).render(10);

  assert.deepEqual(lines.filter((line: string) => line.startsWith("…")), ["… (+3)"]);
  assert.doesNotMatch(lines.join("\n"), /\nb\n|\nc\n|display capped at/);
  assertWidthSafe(lines, 10);
});

test("Bash partial preview preserves complete body text before visual folding", () => {
  const renderResult = resolveResult("bash", { bashOutputMode: "preview", previewLines: 2 }, { command: "printf" });
  const lines = renderResult(result("a\n\n\nb"), options(false, true), theme, { args: { command: "printf" } }).render(20);

  assert.deepEqual(lines.map((line: string) => line.trimEnd()), ["a", "", "… (+2)"]);
  assertWidthSafe(lines, 20);
});

test("Read preview passes complete text to collapsed and expanded visual budgets", () => {
  const renderResult = resolveResult("read", { readOutputMode: "preview", previewLines: 1, expandedPreviewMaxLines: 1 }, { path: "fixture.txt" });
  for (const expanded of [false, true]) {
    const lines = renderResult(result("123456789012345\nb\nc"), options(expanded), theme).render(10);
    assert.deepEqual(lines, ["1234567890", "… (+3)"]);
    assertWidthSafe(lines, 10);
  }
});

for (const toolName of ["grep", "find", "ls"] as const) {
  test(`${toolName} search preview uses the shared complete-text visual budget`, () => {
    const renderResult = resolveResult(toolName, { searchOutputMode: "preview", previewLines: 1 }, { pattern: "x" });
    const lines = renderResult(result("123456789012345\nb\nc"), options(), theme).render(10);

    assert.deepEqual(lines, ["1234567890", "… (+3)"]);
    assertWidthSafe(lines, 10);
  });
}

test("MCP preview keeps display omission singular and backend truncation separate", () => {
  const override = { enabled: true, kind: "mcp" as const, outputMode: "preview" as const, overrideCallRenderer: false };
  const renderResult = resolveResult("mcp", { previewLines: 1, showTruncationHints: true, customToolOverrides: { mcp: override } }, {}, false);
  const lines = renderResult(result("one\ntwo", { truncation: { truncated: true } }), options(), theme).render(80);
  const output = lines.join("\n");

  assert.match(output, /1 more visual line • Ctrl\+O to expand/);
  assert.equal((output.match(/more visual/g) ?? []).length, 1);
  assert.match(output, /truncated by backend limits/);
  assertWidthSafe(lines, 80);
});

test("Custom preview uses visual rows and retains an omission marker at narrow widths", () => {
  const override = { enabled: true, kind: "generic" as const, outputMode: "preview" as const, overrideCallRenderer: false };
  const renderResult = resolveResult("custom", { previewLines: 1, customToolOverrides: { custom: override } }, {}, false);

  for (const width of [1, 2, 5]) {
    const lines = renderResult(result("abcdef\nx"), options(), theme).render(width);
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? "", /…/);
    assertWidthSafe(lines, width);
  }
});

test("Diff collapsed and expanded budgets select logical lines but report omitted visual Diff lines", () => {
  const renderResult = resolveResult("edit", {
    diffViewMode: "unified",
    diffCollapsedLines: 1,
    expandedPreviewMaxLines: 1,
    diffWordWrap: true,
  }, { path: "fixture.txt" });
  const diff = `-${"OLD-" + "o".repeat(146)}\n+${"NEW-" + "n".repeat(146)}\n tail`;

  for (const expanded of [false, true]) {
    const lines = renderResult(result("done", { diff }), options(expanded), theme).render(80);
    const output = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(output, /OLD-/);
    assert.doesNotMatch(output, /NEW-|tail/);
    assert.match(output, /4 more visual diff lines/);
    assert.equal((output.match(/more visual diff/g) ?? []).length, 1);
    assert.equal(output.includes("Ctrl+O to expand"), !expanded);
    assertWidthSafe(lines, 80);
  }
});

test("Diff omission hint uses singular visual-line wording", () => {
  const renderResult = resolveResult("edit", { diffViewMode: "unified", diffCollapsedLines: 1, diffWordWrap: true }, { path: "fixture.txt" });
  const lines = renderResult(result("done", { diff: "-old\n+new" }), options(), theme).render(80);
  const output = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.match(output, /1 more visual diff line • Ctrl\+O to expand/);
  assert.doesNotMatch(output, /1 more visual diff lines/);
  assertWidthSafe(lines, 80);
});
