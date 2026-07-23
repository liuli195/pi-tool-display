import assert from "node:assert/strict";
import test from "node:test";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { createToolDisplayResolver } from "../src/tool-display-resolver.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value };
const render = (component: any) => component.render(120).join("\n");
const output = { content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }], details: { truncation: { truncated: true, originalLines: 10 } } };

function resolve(toolName: "find" | "ls", mode: "count" | "preview", builtIn = false) {
  const native = () => "native";
  return createToolDisplayResolver(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, searchOutputMode: mode, previewLines: 1, showTruncationHints: true }), createRendererCatalog())
    .resolve({ toolName, arguments: { pattern: "*.ts", path: "src", limit: 5 }, builtIn, label: `Third-party ${toolName}` }, { call: native, result: native, shell: "native-shell" });
}

for (const toolName of ["find", "ls"] as const) {
  test(`${toolName} applies count and preview while inactive/third-party ownership is unchanged`, () => {
    for (const mode of ["count", "preview"] as const) {
      const display = resolve(toolName, mode, false);
      assert.equal(display.shell, "native-shell");
      assert.match(render(display.call!({ pattern: "*.ts", path: "src", limit: 5 }, theme)), new RegExp(`${toolName}.*(?:src|\\*\\.ts).*5`, "i"));
      const collapsed = render(display.result!(output, { expanded: false, isPartial: false }, theme));
      const expanded = render(display.result!(output, { expanded: true, isPartial: false }, theme));
      assert.match(collapsed, mode === "count" ? /3 (?:results|entries)/ : /a\.ts/);
      if (mode === "preview") assert.doesNotMatch(collapsed, /b\.ts|c\.ts/);
      assert.match(expanded, /c\.ts/);
      assert.match(expanded, /truncat|10 lines/i);
    }
  });
}

test("disabled find and ls use native call, result, and shell", () => {
  const native = () => "native";
  const resolver = createToolDisplayResolver(() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides, find: false, ls: false } }), createRendererCatalog());
  for (const toolName of ["find", "ls"] as const) assert.deepEqual(resolver.resolve({ toolName, arguments: {}, builtIn: false }, { call: native, result: native, shell: "native-shell" }), { call: native, result: native, shell: "native-shell" });
});
