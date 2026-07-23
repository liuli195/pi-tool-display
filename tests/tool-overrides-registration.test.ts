import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { createRendererCatalog } from "../src/renderer-catalog.ts";
import { decorateToolForDisplay, registerRendererAdapter } from "../tool-display-api-consumer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

interface RegisteredToolLike {
	name: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

interface ExecutableToolLike extends RegisteredToolLike {
	execute: (...args: unknown[]) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
}

async function withTempDir(name: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), name));
	try {
		await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("");
}

function withDefaultReadEditOwners(tools: unknown[] = []): unknown[] {
	const names = new Set(
		tools
			.map((tool) => (tool as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string"),
	);
	const defaults = ["read", "edit"]
		.filter((name) => !names.has(name))
		.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
	return [...defaults, ...tools];
}

function createExtensionApiStub(
	allTools: unknown[] = [],
	activeTools: string[] = ["read", "grep", "find", "ls", "bash", "edit", "write"],
): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): unknown[] {
			return withDefaultReadEditOwners(allTools);
		},
		getActiveTools(): string[] {
			return activeTools;
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, eventHandlers };
}

test("adapter lifecycle drains pending intent, coalesces legacy calls per epoch, and cleans repeated epochs", () => {
	const globalApi = Symbol.for("pi-tool-display.api.v1");
	const globalPending = Symbol.for("pi-tool-display.pendingDecorations.v1");
	const tool = Object.freeze({ name: "lifecycle_tool", execute() {} });
	const row = { toolName: tool.name, arguments: {}, builtIn: false } as const;
	const retainedDispose = registerRendererAdapter({ id: "retained", toolName: tool.name, kind: "generic" });
	try {
		for (let epoch = 0; epoch < 3; epoch++) {
			resetDisposed();
			registerToolDisplayOverrides(createExtensionApiStub().api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
			if (epoch === 0) {
				assert.ok(createRendererCatalog().resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}));
				retainedDispose(); retainedDispose();
			}
			assert.equal(decorateToolForDisplay(tool, { kind: "generic" }), tool);
			assert.equal(decorateToolForDisplay(tool, { kind: "mcp" }), tool, "same-epoch legacy intent replaces without duplicate failure");
			assert.ok(createRendererCatalog().resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}));
			disposeAll();
			assert.equal(createRendererCatalog().resolve(row, DEFAULT_TOOL_DISPLAY_CONFIG, {}), undefined);
		}
	} finally {
		disposeAll(); resetDisposed();
		delete (globalThis as any)[globalApi]; delete (globalThis as any)[globalPending];
	}
});

test("registerToolDisplayOverrides copies built-in prompt metadata onto overridden tools", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	assert.equal(registeredTools.length, 0, "registration waits until owners are known");
	await eventHandlers.session_start?.();
	assert.deepEqual(registeredTools.map((tool) => tool.name).sort(), ["bash"]);
	await eventHandlers.before_agent_start?.();

	assert.equal(registeredTools.length, 1);
	assert.equal(registeredTools.some((tool) => ["read", "grep", "find", "ls", "edit", "write"].includes(tool.name)), false);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		if (["read", "grep", "find", "ls", "edit", "write"].includes(name)) { assert.equal(registeredTool, undefined); continue; }
		const builtInMetadata = builtInTool as unknown as RegisteredToolLike;
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.equal(registeredTool.promptSnippet, builtInMetadata.promptSnippet);
	}

	assert.deepEqual(byName.get("read")?.promptGuidelines, undefined);
	assert.deepEqual(byName.get("edit")?.promptGuidelines, undefined);
	assert.deepEqual(byName.get("write")?.promptGuidelines, undefined);
	assert.equal(byName.get("grep")?.promptGuidelines, undefined);
	assert.equal(byName.get("find")?.promptGuidelines, undefined);
	assert.equal(byName.get("ls")?.promptGuidelines, undefined);
	assert.equal(byName.get("bash")?.promptGuidelines, undefined);
});

test("registerToolDisplayOverrides registers only active built-in renderers after extension loading", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([], ["read", "bash"]);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	assert.equal(registeredTools.length, 0);
	await eventHandlers.session_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const bash = byName.get("bash");
	assert.ok(bash);
	assert.equal(typeof bash.renderCall, "function");
	assert.equal(typeof bash.renderResult, "function");
	for (const name of ["read", "grep", "find", "ls"]) assert.equal(byName.has(name), false);
});

test("registerToolDisplayOverrides clones built-in parameter schemas so Pi TUI keeps extension renderers active", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		if (["read", "grep", "find", "ls", "edit", "write"].includes(name)) { assert.equal(registeredTool, undefined); continue; }
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.notEqual(
			registeredTool.parameters,
			builtInTool.parameters,
			`expected '${name}' to use a cloned parameter object`,
		);
		assert.deepEqual(registeredTool.parameters, builtInTool.parameters);
	}
});

test("registerToolDisplayOverrides leaves edit definition untouched", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();
	assert.equal(registeredTools.some((tool) => tool.name === "edit"), false);
});

test("registerToolDisplayOverrides leaves externally owned read/edit/grep tools active", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{ name: "read", sourceInfo: { source: "local", path: "agent/extensions/example-read/src/read.ts" } },
		{ name: "edit", sourceInfo: { source: "local", path: "agent/extensions/example-edit/src/edit.ts" } },
		{ name: "grep", sourceInfo: { source: "local", path: "agent/extensions/example-grep/src/grep.ts" } },
	]);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.session_start?.();

	const registeredNames = new Set(registeredTools.map((tool) => tool.name));
	assert.equal(registeredNames.has("read"), false);
	assert.equal(registeredNames.has("edit"), false);
	assert.equal(registeredNames.has("grep"), false);
	assert.equal(registeredNames.has("find"), false);
	assert.equal(registeredNames.has("ls"), false);
	assert.equal(registeredNames.has("bash"), true);
	assert.equal(registeredNames.has("write"), false);
});

test("tools with matching third-party owners but missing provenance are not shadowed", async () => {
	for (const owner of [{ name: "read" }, { name: "read", sourceInfo: {} }]) {
		const { api, registeredTools, eventHandlers } = createExtensionApiStub([owner], ["read", "edit"]);
		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
		await eventHandlers.session_start?.();

		const names = new Set(registeredTools.map((tool) => tool.name));
		assert.equal(names.has("read"), false);
		assert.equal(names.has("edit"), false, "edit rendering does not register an executable tool");
	}
});

test("later-loaded read and bash owners are not shadowed", async () => {
	const allTools: unknown[] = [];
	const { api, registeredTools, eventHandlers } = createExtensionApiStub(allTools);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	allTools.push(
		{ name: "read", sourceInfo: { source: "local", path: "pi-hashline-edit-pro" } },
		{ name: "edit", sourceInfo: { source: "local", path: "pi-hashline-edit-pro" } },
		{ name: "bash", sourceInfo: { source: "local", path: "pi-patty-bg-tasks" } },
	);
	await eventHandlers.session_start?.();

	const names = new Set(registeredTools.map((tool) => tool.name));
	assert.equal(names.has("read"), false);
	assert.equal(names.has("edit"), false);
	assert.equal(names.has("bash"), false);
	assert.equal(names.has("write"), false, "write rendering does not register an executable tool");
});

test("bash override uses shellPath from Pi settings", async () => {
	await withTempDir("pi-tool-display-shellpath-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellPath: "/definitely/missing/bash" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			await assert.rejects(
				bashTool.execute("tool-call-1", { command: "printf test" }, undefined, undefined, { cwd: process.cwd() }),
				/custom shell path not found/i,
			);
			assert.equal(bashTool.description.length > 0, true);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});

test("bash override uses shellCommandPrefix from Pi settings", async () => {
	await withTempDir("pi-tool-display-shellprefix-", async (dir) => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "printf 'prefix-output\\n'" }),
			"utf8",
		);

		try {
			const { api, registeredTools, eventHandlers } = createExtensionApiStub();
			registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
			await eventHandlers.before_agent_start?.();

			const bashTool = registeredTools.find((tool) => tool.name === "bash") as ExecutableToolLike | undefined;
			assert.ok(bashTool, "expected bash override to be registered");
			const result = await bashTool.execute(
				"tool-call-2",
				{ command: "printf 'command-output\\n'" },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			assert.equal(getTextOutput(result).trim(), "prefix-output\ncommand-output");
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});

test("registerToolDisplayOverrides drains pending display decorations from early-loading extensions", () => {
	type GlobalWithPendingDecorations = typeof globalThis & {
		[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: Array<{
			tool: Record<string, unknown>;
			adapter?: Record<string, unknown>;
		}>;
	};
	const globalWithPending = globalThis as GlobalWithPendingDecorations;
	const previousPending = globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
	const queuedTool: Record<string, unknown> = {
		name: "mcp",
		label: "MCP Proxy",
		description: "Unified MCP gateway.",
		parameters: {},
		execute(): void {
			// No-op test stub.
		},
	};
	globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = [
		{
			adapter: { kind: "mcp" },
			tool: queuedTool,
		},
	];

	try {
		const { api, registeredTools } = createExtensionApiStub();

		registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

		assert.equal(registeredTools.some((tool) => tool.name === "mcp"), false);
		assert.equal(queuedTool.renderCall, undefined, "queued tool definition stays unchanged");
		assert.equal(queuedTool.renderResult, undefined, "queued tool definition stays unchanged");
		assert.equal(globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY], undefined, "queue drains and releases tool references");
	} finally {
		if (previousPending) {
			globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = previousPending;
		} else {
			delete globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
		}
	}
});
