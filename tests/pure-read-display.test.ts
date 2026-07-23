import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const text = (component: any) => component.render(120).join("\n");
const result = { content: [{ type: "text", text: "one\ntwo\nthree" }], details: { truncation: { truncated: true, originalLines: 9 } } };

function plan(mode: "hidden" | "summary" | "preview", previewLines = 1) {
  const native = () => "native";
  return createToolDisplayResolver(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, readOutputMode: mode, previewLines, showTruncationHints: true }), createRendererCatalog())
    .resolve({ toolName: "read", arguments: { path: "fixture.txt", offset: 2, limit: 7 }, builtIn: false, label: "Third-party read" }, { call: native, result: native, shell: "third-party-shell" });
}

test("same-name third-party read receives display policy without replacing native shell", () => {
  const display = plan("preview");
  assert.equal(display.shell, "third-party-shell");
  assert.match(text(display.call!({ path: "fixture.txt", offset: 2, limit: 7 }, theme)), /read.*fixture\.txt.*2-8/i);
});

test("read hidden, summary, and preview preserve collapsed and expanded behavior", () => {
  for (const [mode, collapsed, expanded] of [["hidden", "", ""], ["summary", "3 lines", "three"], ["preview", "one", "three"]] as const) {
    const display = plan(mode);
    const folded = text(display.result!(result, { expanded: false, isPartial: false }, theme));
    const open = text(display.result!(result, { expanded: true, isPartial: false }, theme));
    assert.equal(mode === "hidden" ? folded === "" : folded.includes(collapsed), true);
    assert.equal(mode === "hidden" ? open === "" : open.includes(expanded), true);
    if (mode !== "hidden") assert.match(open, /truncat|9 lines/i);
  }
});

test("read partial results show native lifecycle status rather than incomplete content", () => {
  const partial = text(plan("preview", 2).result!(result, { expanded: false, isPartial: true }, theme));
  assert.match(partial, /reading/i);
  assert.doesNotMatch(partial, /one|two|three/);
});
