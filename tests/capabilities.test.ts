import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyCapabilityConfigGuards,
	detectToolDisplayCapabilities,
} from "../src/capabilities.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

test("capability detection ignores third-party tool metadata", () => {
	const api = {
		getAllTools(): never {
			throw new Error("tool discovery must not run");
		},
		getCommands(): Array<{ name: string }> {
			return [];
		},
	} as unknown as ExtensionAPI;

	assert.deepEqual(detectToolDisplayCapabilities(api, "."), { hasRtkOptimizer: false });
});

test("RTK guards preserve explicit MCP adapter defaults", () => {
	const guarded = applyCapabilityConfigGuards(
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, mcpOutputMode: "preview" },
		{ hasRtkOptimizer: true },
	);

	assert.equal(guarded.mcpOutputMode, "preview");
	assert.equal(guarded.showRtkCompactionHints, DEFAULT_TOOL_DISPLAY_CONFIG.showRtkCompactionHints);
});
