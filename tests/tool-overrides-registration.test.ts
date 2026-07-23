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

test("registerToolDisplayOverrides copies built-in prompt metadata onto overridden tools", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	assert.equal(registeredTools.length, 0, "registration waits until owners are known");
	await eventHandlers.session_start?.();
	assert.deepEqual(
		registeredTools.map((tool) => tool.name).sort(),
		["bash", "edit", "find", "grep", "ls", "read", "write"],
	);
	await eventHandlers.before_agent_start?.();

	assert.equal(registeredTools.length, 7);

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
		const builtInMetadata = builtInTool as unknown as RegisteredToolLike;
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.equal(registeredTool.promptSnippet, builtInMetadata.promptSnippet);
	}

	assert.deepEqual(byName.get("read")?.promptGuidelines, (builtInTools.read as unknown as RegisteredToolLike).promptGuidelines);
	assert.deepEqual(byName.get("edit")?.promptGuidelines, (builtInTools.edit as unknown as RegisteredToolLike).promptGuidelines);
	assert.deepEqual(byName.get("write")?.promptGuidelines, (builtInTools.write as unknown as RegisteredToolLike).promptGuidelines);
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
	for (const name of ["read", "bash"] as const) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected active '${name}' renderer`);
		assert.equal(typeof registeredTool.renderCall, "function");
		assert.equal(typeof registeredTool.renderResult, "function");
	}
	assert.equal(byName.has("find"), false);
	assert.equal(byName.has("ls"), false);
});

test("restored history can use built-in renderers after session startup", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([], ["read"]);
	registerToolDisplayOverrides(api, () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, readOutputMode: "summary" }));
	await eventHandlers.session_start?.();

	const read = registeredTools.find((tool) => tool.name === "read");
	assert.ok(read?.renderCall && read.renderResult);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const call = read.renderCall({ path: "historic.txt" }, theme) as { render(width: number): string[] };
	const result = read.renderResult(
		{ content: [{ type: "text", text: "historic content" }], details: {} },
		{ expanded: false, isPartial: false },
		theme,
	) as { render(width: number): string[] };
	assert.match(call.render(80).join("\n"), /historic\.txt/);
	assert.ok(result.render(80).length > 0);
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
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.notEqual(
			registeredTool.parameters,
			builtInTool.parameters,
			`expected '${name}' to use a cloned parameter object`,
		);
		assert.deepEqual(registeredTool.parameters, builtInTool.parameters);
	}
});

test("registerToolDisplayOverrides forces edit into the default render shell so tool backgrounds fill the full row", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.before_agent_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	assert.equal(byName.get("edit")?.renderShell, "default");
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
	assert.equal(registeredNames.has("find"), true);
	assert.equal(registeredNames.has("ls"), true);
	assert.equal(registeredNames.has("bash"), true);
	assert.equal(registeredNames.has("write"), true);
});

test("later-loaded read and bash owners are not shadowed", async () => {
	const allTools: unknown[] = [];
	const { api, registeredTools, eventHandlers } = createExtensionApiStub(allTools);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	allTools.push(
		{ name: "read", sourceInfo: { source: "local", path: "pi-hashline-edit-pro" } },
		{ name: "bash", sourceInfo: { source: "local", path: "pi-patty-bg-tasks" } },
	);
	await eventHandlers.session_start?.();

	const names = new Set(registeredTools.map((tool) => tool.name));
	assert.equal(names.has("read"), false);
	assert.equal(names.has("bash"), false);
	assert.equal(names.has("edit"), true, "active ownerless built-ins still receive renderers");
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
		assert.equal(typeof queuedTool.renderCall, "function", "expected queued MCP tool to receive renderCall");
		assert.equal(typeof queuedTool.renderResult, "function", "expected queued MCP tool to receive renderResult");
		assert.equal(globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?.length, 0);
	} finally {
		if (previousPending) {
			globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = previousPending;
		} else {
			delete globalWithPending[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
		}
	}
});
