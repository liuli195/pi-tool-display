import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  CONFIG_DIR_NAME,
  createReadTool,
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const testAgentDir = mkdtempSync(join(tmpdir(), "pi-tool-display-index-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const { default: toolDisplayExtension } = await import("../src/index.ts");
const { createRendererCatalog } = await import("../src/renderer-catalog.ts");
const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/types.ts");
if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
after(() => rmSync(testAgentDir, { recursive: true, force: true }));
initTheme(undefined, false);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedHandler {
  event: string;
  handler: (...args: unknown[]) => unknown;
}

interface CapturedCommand {
  name: string;
  description?: string;
  handler?: (...args: unknown[]) => unknown;
}

function createApiStub(
  overrides: Partial<{
    registerTool: (tool: unknown) => void;
    registerCommand: (name: string, cmd: unknown) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    getAllTools: () => unknown[];
    getCommands: () => Array<{ name: string }>;
  }> = {},
): {
  api: ExtensionAPI;
  capturedTools: Array<{ name: string } & Record<string, unknown>>;
  capturedCommands: CapturedCommand[];
  capturedHandlers: CapturedHandler[];
} {
  const capturedTools: Array<{ name: string } & Record<string, unknown>> = [];
  const capturedCommands: CapturedCommand[] = [];
  const capturedHandlers: CapturedHandler[] = [];

  const api = {
    registerTool(tool: unknown): void {
      capturedTools.push(tool as { name: string } & Record<string, unknown>);
      overrides.registerTool?.(tool);
    },
    registerCommand(name: string, cmd: unknown): void {
      capturedCommands.push({ name, ...(cmd as object) } as CapturedCommand);
      overrides.registerCommand?.(name, cmd);
    },
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      capturedHandlers.push({ event, handler });
      overrides.on?.(event, handler);
    },
    getAllTools(): unknown[] {
      return overrides.getAllTools?.() ?? [];
    },
    getActiveTools(): string[] {
      return ["read", "grep", "find", "ls", "bash", "edit", "write"];
    },
    getCommands(): Array<{ name: string }> {
      return overrides.getCommands?.() ?? [];
    },
  } as unknown as ExtensionAPI;

  return { api, capturedTools, capturedCommands, capturedHandlers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("entry point registers expected lifecycle handlers", () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const eventNames = capturedHandlers.map((h) => h.event);
  assert.equal(eventNames.includes("message_update"), false, "message_update remains untouched");
  assert.equal(eventNames.includes("message_end"), false, "message_end remains untouched");
  assert.equal(eventNames.includes("context"), false, "model context remains untouched");
  // Lifecycle handlers from index.ts directly
  assert.ok(eventNames.includes("session_start"), "session_start handler registered");
  assert.ok(eventNames.includes("before_agent_start"), "before_agent_start handler registered");
  // User-message-box lifecycle handlers
  const sessionStartCount = eventNames.filter((e) => e === "session_start").length;
  assert.ok(sessionStartCount >= 1, "at least one session_start handler registered");
  const beforeAgentStartCount = eventNames.filter((e) => e === "before_agent_start").length;
  assert.ok(beforeAgentStartCount >= 1, "at least one before_agent_start handler registered");
});

test("entry point registers tool-display command on session_start", async () => {
  const { api, capturedCommands, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  // Command registration now happens inside session_start
  for (const { event, handler } of capturedHandlers) if (event === "session_start") await handler({}, { ui: { notify() {} }, cwd: process.cwd(), isProjectTrusted: () => false });

  const cmdNames = capturedCommands.map((c) => c.name);
  assert.ok(cmdNames.includes("tool-display"), "tool-display command registered");
});

test("entry point never registers tools across initialization, lifecycle, config commands, and turns", async () => {
  const { api, capturedTools, capturedHandlers, capturedCommands } = createApiStub();
  toolDisplayExtension(api);
  assert.deepEqual(capturedTools, []);

  const ctx = { hasUI: false, ui: { notify() {}, theme: { fg: (_c: string, text: string) => text } }, cwd: process.cwd(), isProjectTrusted: () => false } as unknown as ExtensionCommandContext;
  for (const event of ["session_start", "before_agent_start", "before_agent_start", "session_shutdown"]) {
    for (const captured of capturedHandlers.filter((entry) => entry.event === event)) {
      await captured.handler(event === "session_shutdown" ? { reason: "reload" } : {}, ctx);
    }
    assert.deepEqual(capturedTools, [], `zero tool registrations after ${event}`);
  }

  const command = capturedCommands.find(({ name }) => name === "tool-display");
  await command?.handler?.("preset balanced", ctx);
  await command?.handler?.("reset", ctx);
  assert.deepEqual(capturedTools, [], "configuration changes remain presentation-only");
});

test("session_start handler refreshes capabilities and notifies pending errors", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler, "session_start handler captured");

  const ctx = {
    ui: {
      theme: { fg: (_c: string, t: string) => t },
      notify: (_msg: string, _level: string) => { /* no-op */ },
    },
    cwd: process.cwd(),
    isProjectTrusted: () => false,
  };

  // Should not throw
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
});

test("before_agent_start handler refreshes capabilities without crashing", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  assert.ok(beforeHandler, "before_agent_start handler captured");

  // Should not throw
  await assert.doesNotReject(async () => beforeHandler());
});

test("multiple calls to toolDisplayExtension are idempotent", async () => {
  const { api, capturedTools, capturedCommands, capturedHandlers } = createApiStub();

  // Call twice
  toolDisplayExtension(api);
  toolDisplayExtension(api);
  // Registration now happens inside session_start
  const sessionCtx = { ui: { theme: {}, notify() {} }, cwd: process.cwd(), isProjectTrusted: () => false };
  for (const { event, handler } of capturedHandlers) if (event === "session_start") await handler({}, sessionCtx);

  const toolNames = capturedTools.map((t) => t.name);
  assert.equal(toolNames.some((name) => ["read", "grep", "find", "ls", "edit", "write"].includes(name)), false);
  assert.equal(toolNames.length, 0);

  const cmdNames = capturedCommands.map((c) => c.name);
  assert.ok(cmdNames.filter((n) => n === "tool-display").length >= 1, "command registered at least once");
});

test("entry point tolerates empty getAllTools and getCommands results", () => {
  // Stub that returns empty arrays for discovery methods
  const { api } = createApiStub({
    getAllTools: () => [],
    getCommands: () => [],
  });

  assert.doesNotThrow(() => toolDisplayExtension(api));
});

test("entry point capability discovery tolerates source metadata", () => {
  const { api } = createApiStub({
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "local", path: "/ext/read.ts" } },
      { name: "edit", sourceInfo: { source: "local", path: "/ext/edit.ts" } },
      { name: "grep", sourceInfo: { source: "local", path: "/ext/grep.ts" } },
    ],
    getCommands: () => [{ name: "custom" }],
  });

  assert.doesNotThrow(() => toolDisplayExtension(api));
});

test("graceful degradation: extension throws when registerCommand is missing", () => {
  const minimalApi = {
    registerTool(): void { /* no-op */ },
    on(): void { /* no-op */ },
    getAllTools(): unknown[] { return []; },
    getCommands(): Array<{ name: string }> { return []; },
  } as unknown as ExtensionAPI;

  assert.throws(
    () => toolDisplayExtension(minimalApi),
    /registerCommand/i,
    "missing registerCommand should propagate during extension registration",
  );
});

test("graceful degradation: extension throws when on is missing", () => {
  const minimalApi = {
    registerTool(): void { /* no-op */ },
    registerCommand(): void { /* no-op */ },
    getAllTools(): unknown[] { return []; },
    getCommands(): Array<{ name: string }> { return []; },
  } as unknown as ExtensionAPI;

  // registerNativeUserMessageBox calls pi.on, so this should throw when on is missing
  assert.throws(
    () => toolDisplayExtension(minimalApi),
    /pi\.on is not a function|on is not a function/i,
    "missing on should propagate",
  );
});

test("lifecycle events fire in expected order during a session lifecycle", async () => {
  // Simulate the sequence: setup → before_agent_start → session_start
  const { api, capturedHandlers } = createApiStub();

  toolDisplayExtension(api);

  // Manually invoke handlers in expected lifecycle order
  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(beforeHandler, "before_agent_start handler found");
  assert.ok(sessionHandler, "session_start handler found");

  // Simulate a session lifecycle
  await beforeHandler();
  await sessionHandler(
    {},
    { ui: { theme: { fg: (_c: string, t: string) => t }, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false },
  );

  // All handlers executed without throwing - this is the main assertion
  assert.ok(true, "lifecycle handlers completed without error");
});

test("session_start handler tolerates missing ctx.ui", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler);

  // ctx with no ui (edge case from older pi versions)
  await assert.doesNotReject(async () => sessionHandler({}, { cwd: process.cwd(), isProjectTrusted: () => false }));
});

test("before_agent_start handler tolerates being called multiple times", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  assert.ok(beforeHandler);

  await assert.doesNotReject(async () => beforeHandler());
  await assert.doesNotReject(async () => beforeHandler());
  await assert.doesNotReject(async () => beforeHandler());
});

test("session_start handler tolerates being called multiple times", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler);

  const ctx = { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false };
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
});

test("session transition and disabled config restore native renderer ownership", async () => {
  const configFile = join(testAgentDir, "extensions", "pi-tool-display", "config.json");
  mkdirSync(join(testAgentDir, "extensions", "pi-tool-display"), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ enabled: true }), "utf8");

  const prototype = ToolExecutionComponent.prototype as unknown as { getCallRenderer: Function };
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  const sessionStart = capturedHandlers.find(({ event }) => event === "session_start")?.handler;
  const sessionShutdown = (reason: string) => {
    for (const { event, handler } of capturedHandlers) if (event === "session_shutdown") handler({ reason });
  };
  const ctx = { ui: { theme: {}, notify() {} }, cwd: process.cwd(), isProjectTrusted: () => false };

  sessionShutdown("new");
  const nativeCall = prototype.getCallRenderer;
  await sessionStart?.({}, ctx);
  assert.notStrictEqual(prototype.getCallRenderer, nativeCall);
  sessionShutdown("new");
  assert.strictEqual(prototype.getCallRenderer, nativeCall);

  writeFileSync(configFile, JSON.stringify({ enabled: false }), "utf8");
  await sessionStart?.({}, ctx);
  assert.strictEqual(prototype.getCallRenderer, nativeCall);
});

test("reload preserves the trusted project overlay before another session_start", async () => {
  const globalConfigFile = join(testAgentDir, "extensions", "pi-tool-display", "config.json");
  mkdirSync(join(testAgentDir, "extensions", "pi-tool-display"), { recursive: true });
  writeFileSync(globalConfigFile, JSON.stringify({ readOutputMode: "hidden" }), "utf8");
  const projectDir = join(testAgentDir, "trusted-project");
  const projectConfigDir = join(projectDir, CONFIG_DIR_NAME, "extensions", "pi-tool-display");
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(join(projectConfigDir, "config.json"), JSON.stringify({ readOutputMode: "preview" }), "utf8");

  const first = createApiStub();
  toolDisplayExtension(first.api);
  const ctx = { ui: { theme: {}, notify() {} }, cwd: projectDir, isProjectTrusted: () => true };
  await first.capturedHandlers.find(({ event }) => event === "session_start")?.handler({}, ctx);
  for (const { event, handler } of first.capturedHandlers) if (event === "session_shutdown") handler({ reason: "reload" });

  const second = createApiStub();
  toolDisplayExtension(second.api);
  const notifications: string[] = [];
  await second.capturedCommands.find(({ name }) => name === "tool-display")?.handler?.("show", {
    ui: { notify(message: string) { notifications.push(message); } },
  });
  assert.match(notifications.join("\n"), /read=preview/);
  for (const { event, handler } of second.capturedHandlers) if (event === "session_shutdown") handler({ reason: "quit" });
});

test("public config mutation invalidates ToolExecution rows already rendered", async () => {
  const runtime = createApiStub();
  toolDisplayExtension(runtime.api);
  const row = new ToolExecutionComponent(
    "read",
    "config-refresh",
    { path: "fixture.txt" },
    {},
    createReadTool(process.cwd()),
    { requestRender() {} } as any,
    process.cwd(),
  );
  row.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details: {} } as any);
  row.render(80);
  const originalInvalidate = row.invalidate.bind(row);
  let invalidations = 0;
  row.invalidate = () => { invalidations++; originalInvalidate(); };

  await runtime.capturedCommands.find(({ name }) => name === "tool-display")?.handler?.("preset balanced", {
    ui: { notify() {} },
  });
  assert.ok(invalidations > 0);
  for (const { event, handler } of runtime.capturedHandlers) if (event === "session_shutdown") handler({ reason: "quit" });
});

test("ordinary session factory replacement preserves producer Adapter intent", () => {
  const first = createApiStub();
  toolDisplayExtension(first.api);
  const apiSymbol = Symbol.for("pi-tool-display.api.v1");
  const producerApi = (globalThis as any)[apiSymbol];
  producerApi.registerAdapter({ id: "before-transition", toolName: "before_transition", kind: "generic" });
  for (const { event, handler } of first.capturedHandlers) if (event === "session_shutdown") handler({ reason: "new" });
  producerApi.registerAdapter({ id: "during-transition", toolName: "during_transition", kind: "generic" });

  const second = createApiStub();
  toolDisplayExtension(second.api);
  assert.strictEqual((globalThis as any)[apiSymbol], producerApi);
  const catalog = createRendererCatalog();
  assert.ok(catalog.resolve({ toolName: "before_transition", arguments: {} }, DEFAULT_TOOL_DISPLAY_CONFIG, {}));
  assert.ok(catalog.resolve({ toolName: "during_transition", arguments: {} }, DEFAULT_TOOL_DISPLAY_CONFIG, {}));
  for (const { event, handler } of second.capturedHandlers) if (event === "session_shutdown") handler({ reason: "quit" });
});

test("display policy installs without registering executable definitions", async () => {
  const { api, capturedTools, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  for (const { event, handler } of capturedHandlers) if (event === "session_start") await handler({}, { ui: { notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false });
  assert.equal(capturedTools.length, 0);

  for (const tool of capturedTools) {
    assert.ok(
      typeof tool.renderCall === "function",
      `${tool.name} has renderCall`,
    );
    assert.ok(
      typeof tool.renderResult === "function",
      `${tool.name} has renderResult`,
    );
  }
});

test("display policy does not replace built-in definitions", async () => {
  const { api, capturedTools, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  for (const { event, handler } of capturedHandlers) if (event === "before_agent_start") await handler();
  assert.deepEqual(capturedTools, []);
});
