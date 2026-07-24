import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box, type Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "../src/diff-renderer.ts";

const theme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

const diffConfig = {
	diffViewMode: "auto" as const,
	diffSplitMinWidth: 80,
	diffCollapsedLines: 24,
	diffWordWrap: false,
	diffIndicatorMode: "bars" as const,
	expandedPreviewMaxLines: 32,
};

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width);
}

function buildLargeUnifiedDiff(changeCount: number): string {
	const lines = [
		"--- a/large.txt",
		"+++ b/large.txt",
		`@@ -1,${changeCount} +1,${changeCount} @@`,
	];
	for (let lineNumber = 1; lineNumber <= changeCount; lineNumber++) {
		lines.push(`-old line ${lineNumber}`);
		lines.push(`+new line ${lineNumber}`);
	}
	return lines.join("\n");
}

test("issue #23: expanded large diffs cap logical Diff lines in small tmux panes", () => {
	const component = renderEditDiffResult(
		{ diff: buildLargeUnifiedDiff(80) },
		{ expanded: true, filePath: "large.txt" },
		diffConfig as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, 100);
	const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(
		lines.length <= diffConfig.expandedPreviewMaxLines + 10,
		`expected expanded large diff to stay bounded near ${diffConfig.expandedPreviewMaxLines} logical lines, rendered ${lines.length}`,
	);
	assert.ok(plain.some((line) => line.includes("new line 32")));
	assert.ok(plain.every((line) => !line.includes("old line 33")));
	assert.ok(
		plain.some((line) => /more visual diff lines/i.test(line)),
		"expected a visual Diff-line omission hint",
	);
});

test("PR #24: lockfile uses patched esbuild 0.28.1", () => {
	const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
		packages?: Record<string, { version?: string }>;
	};
	assert.equal(lockfile.packages?.["node_modules/esbuild"]?.version, "0.28.1");
});
