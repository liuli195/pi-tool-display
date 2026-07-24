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

test("zero Bash body budget still reports omitted visual rows for partial and complete output", () => {
  const renderResult = resolveResult("bash", { bashOutputMode: "opencode", bashCollapsedLines: 0 }, { command: "printf" });
  for (const isPartial of [false, true]) {
    const lines = renderResult(result("one\ntwo"), options(false, isPartial), theme, { args: { command: "printf" } }).render(40);
    assert.deepEqual(lines, ["… (2 more visual lines)"]);
  }
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

test("shared visual preview handles required widths and text widths", () => {
  const renderResult = resolveResult("read", { readOutputMode: "preview", previewLines: 1 }, { path: "fixture.txt" });
  for (const width of [20, 40, 120, 10_000]) {
    const lines = renderResult(result("x".repeat(width + 1)), options(), theme).render(width);
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? "", width < 40 ? /\+1/ : /1 more visual line/);
    assertWidthSafe(lines, width);
  }

  for (const text of ["\x1b[31m12345678901\x1b[0m", "界界界界界界", "🙂🙂🙂🙂🙂🙂"]) {
    const lines = renderResult(result(text), options(), theme).render(10);
    assert.equal(lines.length, 2);
    assert.match(lines[1] ?? "", /1 more visual line|…/);
    assertWidthSafe(lines, 10);
  }
});

test("default and unlimited expanded visual budgets keep their public semantics", () => {
  const defaultPreview = resolveResult("read", { readOutputMode: "preview" }, { path: "fixture.txt" });
  const collapsed = defaultPreview(result(Array.from({ length: 9 }, (_, index) => `row-${index}`).join("\n")), options(), theme).render(120);
  assert.match(collapsed.at(-1) ?? "", /1 more visual line/);

  const unlimited = resolveResult("read", { readOutputMode: "preview", expandedPreviewMaxLines: 0 }, { path: "fixture.txt" });
  const expanded = unlimited(result("one\ntwo\nthree"), options(true), theme).render(40);
  assert.deepEqual(expanded.map((line) => line.trimEnd()), ["one", "two", "three"]);
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

test("Diff visual omission count responds to width while logical selection stays fixed", () => {
  const renderResult = resolveResult("edit", { diffViewMode: "unified", diffCollapsedLines: 1, diffWordWrap: true }, { path: "fixture.txt" });
  const diff = `-${"OLD-" + "o".repeat(146)}\n+${"NEW-" + "n".repeat(146)}\n tail`;
  const counts = new Map<number, number>();
  for (const width of [40, 120]) {
    const output = renderResult(result("done", { diff }), options(), theme).render(width).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(output, /OLD-/);
    assert.doesNotMatch(output, /NEW-|tail/);
    const count = Number(/(\d+) more visual diff lines?/.exec(output)?.[1]);
    assert.ok(Number.isInteger(count) && count > 0);
    counts.set(width, count);
  }
  assert.ok((counts.get(40) ?? 0) > (counts.get(120) ?? 0));
});

test("Diff logical budget hides metadata belonging only to omitted hunks", () => {
  const renderResult = resolveResult("edit", { diffViewMode: "unified", diffCollapsedLines: 1, diffWordWrap: true }, { path: "fixture.txt" });
  const diff = [
    "@@ -1,1 +1,1 @@ first-hunk",
    "-first old",
    "+first new",
    "@@ -20,1 +20,1 @@ second-hunk",
    "-second old",
    "+second new",
  ].join("\n");
  const output = renderResult(result("done", { diff }), options(), theme).render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.match(output, /first-hunk/);
  assert.match(output, /first old/);
  assert.doesNotMatch(output, /second-hunk|second old|second new/);
  assert.match(output, /more visual diff lines/);
});

test("Diff omission hint uses singular visual-line wording", () => {
  const renderResult = resolveResult("edit", { diffViewMode: "unified", diffCollapsedLines: 1, diffWordWrap: true }, { path: "fixture.txt" });
  const lines = renderResult(result("done", { diff: "-old\n+new" }), options(), theme).render(80);
  const output = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.match(output, /1 more visual diff line • Ctrl\+O to expand/);
  assert.doesNotMatch(output, /1 more visual diff lines/);
  assertWidthSafe(lines, 80);
});
