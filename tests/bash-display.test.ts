import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { renderBashCall } from "../src/bash-display.ts";

// ─── Test Helpers ────────────────────────────────────────────────────────────

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	expanded?: boolean;
	lastComponent?: unknown;
}

/** Pass-through theme that returns text unchanged */
function createPassThroughTheme(): BashCallRenderTheme {
	return {
		fg: (_color: string, text: string): string => text,
		bold: (text: string): string => text,
	};
}

/** ANSI-producing theme so rendered output can be verified structurally */
function createAnsiTheme(): BashCallRenderTheme {
	return {
		fg: (color: string, text: string): string =>
			`\x1b[${color === "warning" ? "93" : color === "muted" ? "90" : color === "toolTitle" ? "94" : color === "accent" ? "92" : "0"}m${text}\x1b[0m`,
		bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
	};
}

function makeContext(overrides: Partial<BashCallRenderContextLike> = {}): BashCallRenderContextLike {
	return {
		executionStarted: false,
		isPartial: false,
		...overrides,
	};
}

function renderedText(component: Component, width = 120): string {
	return component.render(width).map((line) => line.trimEnd()).join("\n").trim();
}

// ─── Args Shapes ─────────────────────────────────────────────────────────────

test("renderBashCall uses ellipsis when command is missing", () => {
	const text = renderBashCall({}, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall uses ellipsis when command is empty string", () => {
	const text = renderBashCall({ command: "" }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall uses ellipsis when command is only whitespace", () => {
	const text = renderBashCall({ command: "   " }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall displays short command", () => {
	const text = renderBashCall({ command: "npm test" }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall handles very long commands without crashing", () => {
	// Text wraps at render width (120), extremely long commands wrap to multiple lines
	const longCmd = "node " + "a".repeat(200);
	const text = renderBashCall({ command: longCmd }, createPassThroughTheme(), makeContext());
	const output = renderedText(text);
	// Command prefix should still appear (the "$ " prefix is always present)
	assert.ok(output.includes("$"), "dollar sign should appear");
	assert.ok(output.includes("node"), "command text should appear");
	// The rendered output should contain the command text
	assert.ok(output.length > 10, "output should have content");
});

test("renderBashCall previews long commands by visual line", () => {
	const text = renderBashCall(
		{ command: "echo " + "word ".repeat(30) },
		createPassThroughTheme(),
		makeContext(),
		{ bashCommandMode: "preview", bashCommandPreviewLines: 2 },
	);
	const lines = text.render(60);
	assert.equal(lines.length, 3);
	assert.match(lines[2] ?? "", /more visual lines.*Ctrl\+O to expand/);
});

test("renderBashCall expands the complete command", () => {
	const command = "echo " + "word ".repeat(30);
	const text = renderBashCall(
		{ command },
		createPassThroughTheme(),
		makeContext({ expanded: true }),
		{ bashCommandMode: "preview", bashCommandPreviewLines: 2 },
	);
	assert.doesNotMatch(renderedText(text, 30), /more visual lines/);
	assert.ok(text.render(30).length > 3);
});

test("renderBashCall summary mode keeps one visual command line", () => {
	const text = renderBashCall(
		{ command: "echo " + "word ".repeat(30) },
		createPassThroughTheme(),
		makeContext(),
		{ bashCommandMode: "summary", bashCommandPreviewLines: 10 },
	);
	assert.equal(text.render(30).length, 2);
});

test("renderBashCall full mode never folds the command", () => {
	const text = renderBashCall(
		{ command: "echo " + "word ".repeat(30) },
		createPassThroughTheme(),
		makeContext(),
		{ bashCommandMode: "full", bashCommandPreviewLines: 1 },
	);
	assert.doesNotMatch(renderedText(text, 30), /more visual lines/);
	assert.ok(text.render(30).length > 2);
});

test("renderBashCall displays multiline command", () => {
	const text = renderBashCall(
		{ command: "echo hello\necho world" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.ok(renderedText(text).includes("echo hello\necho world"));
});

test("renderBashCall appends timeout suffix when timeout is provided", () => {
	const text = renderBashCall(
		{ command: "npm test", timeout: 30 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test (timeout 30s)");
});

test("renderBashCall does not include timeout suffix when timeout is zero", () => {
	const text = renderBashCall(
		{ command: "npm test", timeout: 0 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall does not include timeout suffix when timeout is undefined", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test");
});

// ─── Theme Variations ────────────────────────────────────────────────────────

test("renderBashCall applies ANSI bold to the dollar sign with ANSI theme", () => {
	const text = renderBashCall({ command: "ls" }, createAnsiTheme(), makeContext());
	const rendered = renderedText(text);
	assert.ok(rendered.includes("\x1b[1m$\x1b[0m"), `expected bold $ in: ${JSON.stringify(rendered)}`);
});

test("renderBashCall applies ANSI color to command with ANSI theme", () => {
	const text = renderBashCall({ command: "ls" }, createAnsiTheme(), makeContext());
	const rendered = renderedText(text);
	assert.ok(rendered.includes("\x1b[92mls\x1b[0m"), `expected green ls in: ${JSON.stringify(rendered)}`);
});

// ─── Context States ──────────────────────────────────────────────────────────

test("renderBashCall renders command text regardless of executionStarted/isPartial", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: false, isPartial: false }),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall renders command text when executionStarted and isPartial are true", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: true, isPartial: true }),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall does not create spinner state when state is null/undefined", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
		}),
	);
	assert.equal(renderedText(text), "$ npm test");
});

// ─── lastComponent Preservation ──────────────────────────────────────────────

test("renderBashCall preserves the same component reference via lastComponent", () => {
	const first = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: true, isPartial: true }),
	);

	const second = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: false,
			lastComponent: first,
		}),
	);

	assert.equal(first, second, "should return the same component instance via lastComponent");
});

// ─── No Spinner Animation ────────────────────────────────────────────────────

test("renderBashCall does not use setInterval or invalidate for animation", () => {
	const originalSetInterval = globalThis.setInterval;
	let intervalCreated = false;
	globalThis.setInterval = ((fn: (...args: unknown[]) => unknown, ms?: number, ..._args: unknown[]) => {
		intervalCreated = true;
		return originalSetInterval(fn, ms ?? 0);
	}) as typeof globalThis.setInterval;

	try {
		const text = renderBashCall(
			{ command: "npm test" },
			createPassThroughTheme(),
			makeContext({ executionStarted: true, isPartial: true }),
		);
		assert.equal(renderedText(text), "$ npm test");
		assert.equal(intervalCreated, false, "no setInterval should be created");
	} finally {
		globalThis.setInterval = originalSetInterval;
	}
});

test("renderBashCall renders deterministic output for partial execution", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: true, isPartial: true }),
	);
	// No spinner frame, no elapsed time — just the command
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall does not show elapsed time or spinner frames", () => {
	const text = renderBashCall(
		{ command: "npm test", timeout: 30 },
		createPassThroughTheme(),
		makeContext({ executionStarted: true, isPartial: true }),
	);
	const rendered = renderedText(text);
	assert.doesNotMatch(rendered, /^⠋/, "no spinner frame");
	assert.doesNotMatch(rendered, /· \d+s$/, "no elapsed time");
	assert.equal(rendered, "$ npm test (timeout 30s)");
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

test("renderBashCall handles command with special characters like $ and backticks", () => {
	const text = renderBashCall(
		{ command: "echo $HOME && echo `pwd`" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.ok(renderedText(text).includes("$HOME"));
	assert.ok(renderedText(text).includes("`pwd`"));
});

test("renderBashCall handles numeric timeout with decimal value", () => {
	const text = renderBashCall(
		{ command: "sleep 1", timeout: 2.5 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ sleep 1 (timeout 2.5s)");
});
