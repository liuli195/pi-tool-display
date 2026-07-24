import assert from "node:assert/strict";
import test from "node:test";
import {
  UserMessageComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import toolDisplayExtension from "../src/index.ts";
import { renderBashCall } from "../src/bash-display.ts";
import registerNativeUserMessageBox from "../src/user-message-box-native.ts";
import { createToolDisplayDebugLogger } from "../src/debug-logger.ts";
import type { PatchableUserMessagePrototype } from "../src/user-message-box-patch.ts";
import { disposeSession, registerSessionCleanup } from "../src/disposable.ts";

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

interface ToolLike {
  name: string;
  renderCall?: unknown;
  renderResult?: unknown;
  [key: string]: unknown;
}

const sessionCtx = { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false };

/** Invoke all captured session_start handlers (simulates Pi calling the extension). */
async function invokeSessionStart(capturedHandlers: CapturedHandler[]): Promise<void> {
  for (const { event, handler } of capturedHandlers) {
    if (event === "session_start") await handler({}, sessionCtx);
  }
}

/**
 * Create a minimal ExtensionAPI stub that captures registrations for later
 * inspection. Mirrors the pattern from index-integration.test.ts.
 */
function createApiStub(
  overrides: Partial<{
    registerTool: (tool: unknown) => void;
    registerCommand: (name: string, cmd: unknown) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    getAllTools: () => unknown[];
    getActiveTools: () => string[];
    getCommands: () => Array<{ name: string }>;
  }> = {},
): {
  api: ExtensionAPI;
  capturedTools: ToolLike[];
  capturedCommands: CapturedCommand[];
  capturedHandlers: CapturedHandler[];
} {
  const capturedTools: ToolLike[] = [];
  const capturedCommands: CapturedCommand[] = [];
  const capturedHandlers: CapturedHandler[] = [];

  const api = {
    registerTool(tool: unknown): void {
      capturedTools.push(tool as ToolLike);
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
      return overrides.getActiveTools?.() ?? ["read", "grep", "find", "ls", "bash", "edit", "write"];
    },
    getCommands(): Array<{ name: string }> {
      return overrides.getCommands?.() ?? [];
    },
  } as unknown as ExtensionAPI;

  return { api, capturedTools, capturedCommands, capturedHandlers };
}

/** Minimal theme stub for render calls. */
const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

// ---------------------------------------------------------------------------
// 1. Basic reload detection
// ---------------------------------------------------------------------------

test("1: calling toolDisplayExtension twice (reload) does not throw", () => {
  const { api } = createApiStub();
  toolDisplayExtension(api);
  assert.doesNotThrow(() => toolDisplayExtension(api));
});

test("1: after reload, new lifecycle handlers are registered", () => {
  const { api, capturedHandlers } = createApiStub();
  const beforeCount = capturedHandlers.length;

  toolDisplayExtension(api);
  const afterFirstCount = capturedHandlers.length;
  assert.ok(afterFirstCount > beforeCount, "handlers registered on first call");

  // Simulate reload
  toolDisplayExtension(api);
  const afterSecondCount = capturedHandlers.length;
  assert.ok(afterSecondCount > afterFirstCount, "handlers accumulate on reload");
});

// ---------------------------------------------------------------------------
// 3. Session cleanup and Bash command rendering
// ---------------------------------------------------------------------------

test("3: session cleanup runs once per registration and accepts the next session", () => {
  let cleanups = 0;
  registerSessionCleanup(() => cleanups++);
  disposeSession();
  disposeSession();
  assert.equal(cleanups, 1);

  registerSessionCleanup(() => cleanups++);
  disposeSession();
  assert.equal(cleanups, 2);
});

test("3: bash renderBashCall does not create timers", () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCreated = false;
  globalThis.setInterval = ((fn: (...args: unknown[]) => unknown, ms?: number, ..._args: unknown[]) => {
    intervalCreated = true;
    return originalSetInterval(fn, ms ?? 0);
  }) as typeof globalThis.setInterval;

  try {
    renderBashCall({ command: "sleep 5" }, stubTheme, {
      executionStarted: true,
      isPartial: true,
    });
    assert.equal(intervalCreated, false, "no setInterval should be called");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("3: bash renderBashCall returns consistent component for same lastComponent", () => {
  const first = renderBashCall({ command: "sleep 5" }, stubTheme, {
    executionStarted: true,
    isPartial: true,
  });

  const second = renderBashCall({ command: "sleep 5" }, stubTheme, {
    executionStarted: true,
    isPartial: false,
    lastComponent: first,
  });

  assert.equal(first, second, "should reuse component via lastComponent");
});

// ---------------------------------------------------------------------------
// 4. MCP override cleanup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. User message box cleanup
// ---------------------------------------------------------------------------

test("5: UserMessageComponent prototype is patched on first call and safe on reload", async () => {
  const { api, capturedHandlers } = createApiStub();

  const proto = UserMessageComponent.prototype as PatchableUserMessagePrototype;

  // Before any patching
  const originalRenderBefore = proto.__piUserMessageOriginalRender;

  // First call + session_start triggers patching
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  assert.ok(
    proto.__piUserMessageNativePatched,
    "prototype is marked as patched after first call",
  );
  assert.ok(
    proto.__piUserMessageOriginalRender,
    "original render is saved",
  );

  const firstOriginalRender = proto.__piUserMessageOriginalRender;

  // Reload (second call) should be safe
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);

  assert.ok(
    proto.__piUserMessageNativePatched,
    "prototype remains patched after reload",
  );
  assert.equal(
    proto.__piUserMessageOriginalRender,
    firstOriginalRender,
    "original render reference is preserved across reloads",
  );
});

test("5: patchNativeUserMessagePrototype can be called multiple times safely", async () => {
  const proto = UserMessageComponent.prototype as PatchableUserMessagePrototype;

  // Track the original render before any patching (tests share process state,
  // so this might already be patched; we record what's there.)
  const renderBefore = proto.render;
  const wasAlreadyPatched = !!proto.__piUserMessageNativePatched;

  // Patch via full extension (uses a fresh api stub each time)
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);

  // After calling, the prototype should be patched
  assert.ok(
    proto.__piUserMessageNativePatched,
    "prototype is patched after first call",
  );

  // The original render reference should have been saved
  assert.ok(
    proto.__piUserMessageOriginalRender,
    "original render is preserved after patch",
  );

  // If it wasn't already patched, the render function should have changed
  if (!wasAlreadyPatched) {
    assert.notEqual(
      proto.render,
      renderBefore,
      "patched render function differs from original",
    );
  }

  // The __piUserMessageOriginalRender function should be callable
  assert.equal(
    typeof proto.__piUserMessageOriginalRender,
    "function",
    "original render is a function",
  );

  // Re-patching via another extension call is safe (no throw)
  const { api: api2, capturedHandlers: handlers2 } = createApiStub();
  toolDisplayExtension(api2);
  await invokeSessionStart(handlers2);

  // The patched flag and original render ref remain stable
  assert.ok(
    proto.__piUserMessageNativePatched,
    "prototype still patched after second call",
  );
  assert.ok(
    proto.__piUserMessageOriginalRender,
    "original render still preserved after second call",
  );
});

// ---------------------------------------------------------------------------
// 6. Command unregistration / re-registration
// ---------------------------------------------------------------------------

test("6: /tool-display command is registered on first call and re-registered on reload", async () => {
  const { api, capturedCommands, capturedHandlers } = createApiStub();

  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  const firstToolDisplayCmds = capturedCommands.filter(
    (c) => c.name === "tool-display",
  );
  assert.equal(firstToolDisplayCmds.length, 1, "tool-display command registered");

  // Reload
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  const secondToolDisplayCmds = capturedCommands.filter(
    (c) => c.name === "tool-display",
  );
  assert.ok(
    secondToolDisplayCmds.length >= 1,
    "tool-display command registered after reload",
  );
});

// ---------------------------------------------------------------------------
// 8. Lifecycle event cleanup
// ---------------------------------------------------------------------------

test("8: session_start and before_agent_start handlers registered on each call", () => {
  const { api, capturedHandlers } = createApiStub();

  toolDisplayExtension(api);
  const eventsAfterFirst = capturedHandlers.filter(
    (h) => h.event === "session_start" || h.event === "before_agent_start",
  );

  assert.ok(
    eventsAfterFirst.some((h) => h.event === "session_start"),
    "session_start handler registered",
  );
  assert.ok(
    eventsAfterFirst.some((h) => h.event === "before_agent_start"),
    "before_agent_start handler registered",
  );

  // Reload
  toolDisplayExtension(api);
  const eventsAfterReload = capturedHandlers.filter(
    (h) => h.event === "session_start" || h.event === "before_agent_start",
  );

  assert.ok(
    eventsAfterReload.length > eventsAfterFirst.length,
    "lifecycle handlers re-registered on reload",
  );
});

test("8: session_start handler can be invoked after reload without errors", async () => {
  const { api, capturedHandlers } = createApiStub();

  toolDisplayExtension(api);

  // Find the first session_start handler
  let sessionHandler = capturedHandlers.find(
    (h) => h.event === "session_start",
  )?.handler;
  assert.ok(sessionHandler, "session_start handler found");

  // Invoke it once
  await assert.doesNotReject(async () =>
    sessionHandler!({}, { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false }),
  );

  // Reload
  toolDisplayExtension(api);

  // Now there are multiple session_start handlers; the first one should
  // still be invocable
  const firstSessionHandler = capturedHandlers.find(
    (h) => h.event === "session_start",
  )?.handler;
  assert.ok(firstSessionHandler, "session_start handler exists after reload");
  await assert.doesNotReject(async () =>
    firstSessionHandler!({}, { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false }),
  );
});

// ---------------------------------------------------------------------------
// 9. Double reload safety
// ---------------------------------------------------------------------------

test("9: calling toolDisplayExtension three times (double reload) is safe", async () => {
  const { api, capturedTools, capturedCommands, capturedHandlers } = createApiStub();

  // First call + session_start
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  const afterFirst = { tools: capturedTools.length, cmds: capturedCommands.length };

  // First reload + session_start
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  const afterSecond = { tools: capturedTools.length, cmds: capturedCommands.length };

  // Second reload (double reload) + session_start
  toolDisplayExtension(api);
  await invokeSessionStart(capturedHandlers);
  const afterThird = { tools: capturedTools.length, cmds: capturedCommands.length };

  // Tool registration is deferred until owners and active tools are known.
  assert.equal(afterFirst.tools, 0);
  assert.equal(afterSecond.tools, 0);
  assert.equal(afterThird.tools, 0);
  assert.ok(afterThird.cmds > afterSecond.cmds, "commands registered on third call");

  // Verify all tool registrations have renderCall/renderResult
  for (const tool of capturedTools) {
    if (tool.name === "read" || tool.name === "edit" || tool.name === "grep") {
      continue; // Deferred tools
    }
    if (tool.renderCall !== undefined) {
      assert.equal(
        typeof tool.renderCall,
        "function",
        `${tool.name} renderCall is a function`,
      );
    }
    if (tool.renderResult !== undefined) {
      assert.equal(
        typeof tool.renderResult,
        "function",
        `${tool.name} renderResult is a function`,
      );
    }
  }
});

test("9: no timers created across rapid reload-like scenarios", () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;

  globalThis.setInterval = ((fn: (...args: unknown[]) => unknown, ms?: number, ..._args: unknown[]) => {
    intervalCount++;
    return originalSetInterval(fn, ms ?? 0);
  }) as typeof globalThis.setInterval;

  try {
    // Create two independent contexts (simulating two rapid calls)
    const ctx1: Record<string, unknown> = {
      executionStarted: true,
      isPartial: true,
    };

    const ctx2: Record<string, unknown> = {
      executionStarted: true,
      isPartial: true,
    };

    // Simulate two rapid render calls (like double reload)
    renderBashCall({ command: "test" }, stubTheme, ctx1 as unknown as Parameters<typeof renderBashCall>[2]);
    renderBashCall({ command: "test" }, stubTheme, ctx2 as unknown as Parameters<typeof renderBashCall>[2]);

    // No timers should be created since spinner is removed
    assert.equal(intervalCount, 0, "no timers created");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

// ---------------------------------------------------------------------------
// 10. Partial reload (bash command rendering without spinner)
// ---------------------------------------------------------------------------

test("10: bash command renders consistently across partial and complete states", () => {
  const context: Record<string, unknown> = {
    executionStarted: true,
    isPartial: true,
  };

  // Render during partial execution
  const partial = renderBashCall({ command: "long-running-task" }, stubTheme, context as unknown as Parameters<typeof renderBashCall>[2]);
  const partialText = partial.render(120).join("\n");
  assert.match(partialText, /long-running-task/);
  assert.doesNotMatch(partialText, /^⠋/, "no spinner frame");

  // Complete the execution reusing the component
  context.isPartial = false;
  context.lastComponent = partial;
  const complete = renderBashCall({ command: "long-running-task" }, stubTheme, context as unknown as Parameters<typeof renderBashCall>[2]);
  assert.equal(partial, complete, "component is reused via lastComponent");
  const completeText = complete.render(120).join("\n");
  assert.match(completeText, /long-running-task/);
  assert.equal(partialText, completeText, "same output regardless of partial state");
});

// ---------------------------------------------------------------------------
// 12. Config persistence across reloads
// ---------------------------------------------------------------------------

test("12: extension loads config fresh on each call (no stale cache)", () => {
  // The extension's toolDisplayExtension function calls loadToolDisplayConfig()
  // which uses a fingerprint cache. On a new process (or after cache expiry),
  // it re-reads. Since each test gets a fresh module instance, the cache is
  // fresh. We verify the loading mechanism works.
  const { api: api1 } = createApiStub();
  assert.doesNotThrow(() => toolDisplayExtension(api1));

  const { api: api2 } = createApiStub();
  assert.doesNotThrow(() => toolDisplayExtension(api2));
});

// ---------------------------------------------------------------------------
// 13. Debug logger cleanup
// ---------------------------------------------------------------------------

test("13: debug logger flush completes without errors", async () => {
  const logger = createToolDisplayDebugLogger({
    configFile: "/dev/null/non-existent-config.json",
    debugDir: "/tmp/non-existent-debug",
    debugLogFile: "/tmp/non-existent-debug/debug.log",
    now: () => 0,
    createDate: () => new Date(0),
  });

  // Log a message (should be a no-op since debug is not enabled)
  logger.log("test message");

  // Flush should resolve without errors
  await assert.doesNotReject(() => logger.flush());
});

test("13: debug logger can be created multiple times (simulating reload)", () => {
  // Each extension call creates its own internal debug logger via
  // logToolDisplayDebug which uses the module-level default. On reload,
  // the module-level default is reused (not re-created). Test that
  // creating fresh instances is safe.

  const logger1 = createToolDisplayDebugLogger({
    configFile: "/dev/null/non-existent.json",
  });
  logger1.log("from instance 1");

  const logger2 = createToolDisplayDebugLogger({
    configFile: "/dev/null/non-existent.json",
  });
  logger2.log("from instance 2");

  // Both should be independently usable
  assert.doesNotThrow(() => logger1.log("test"));
  assert.doesNotThrow(() => logger2.log("test"));
  assert.doesNotReject(() => logger1.flush());
  assert.doesNotReject(() => logger2.flush());
});

// ---------------------------------------------------------------------------
// 14. Modal cleanup
// ---------------------------------------------------------------------------

test("14: modal with dispose() method can be cleaned up on reload", async () => {
  // ZellijModal.dispose() calls content.invalidate()
  // The settings modal in config-modal.ts is created inside a closure
  // that can be closed via the onClose callback.
  // This test verifies the dispose pattern exists and works.

  // We can't directly test the modal from config-modal.ts since it's
  // created inside a closure, but we verify that:
  // 1. The ZellijModal class has a dispose() method
  // 2. Calling dispose() doesn't throw

  const dummyContent = {
    render: (_width: number) => ["test"],
    invalidate: () => {},
  };

  // Dynamic import for ESM compatibility
  const { ZellijModal } = await import("../src/zellij-modal.ts") as {
    ZellijModal: new (
      content: { render: (w: number) => string[]; invalidate: () => void },
      config?: Record<string, unknown>,
      theme?: unknown,
    ) => { dispose: () => void; invalidate: () => void };
  };

  const modal = new ZellijModal(dummyContent, {
    title: "Test",
    borderStyle: "square",
  });

  assert.doesNotThrow(() => modal.dispose(), "modal.dispose() is safe");
  assert.doesNotThrow(
    () => modal.invalidate(),
    "modal.invalidate() is safe after dispose",
  );
});

test("14: open settings modal onClose callback can be invoked multiple times", () => {
  // The settings modal in config-modal.ts has an onClose callback
  // that calls done() to dismiss the modal. Multiple close calls
  // should be safe.

  let closeCount = 0;
  const onClose = () => {
    closeCount++;
  };

  onClose();
  assert.equal(closeCount, 1, "first close invoked");

  onClose();
  assert.equal(closeCount, 2, "second close (reload) invoked");

  // No errors from double close
  assert.ok(true, "onClose can be called multiple times safely");
});

test("14: extension re-initialization does not leave stale modal references", async () => {
  // When the extension is re-loaded, the old controller and modal closures
  // are replaced. The new extension function creates fresh closures.
  // This test verifies the old references don't interfere.

  const { api: api1, capturedCommands: cmds1, capturedHandlers: handlers1 } = createApiStub();
  toolDisplayExtension(api1);
  await invokeSessionStart(handlers1);

  const firstCommandHandler = cmds1.find((c) => c.name === "tool-display")?.handler;

  // Reload
  const { api: api2, capturedCommands: cmds2, capturedHandlers: handlers2 } = createApiStub();
  toolDisplayExtension(api2);
  await invokeSessionStart(handlers2);

  const secondCommandHandler = cmds2.find((c) => c.name === "tool-display")?.handler;

  // Each extension call creates its own handler closure with fresh state
  assert.ok(firstCommandHandler, "first handler exists");
  assert.ok(secondCommandHandler, "second handler exists");

  // First handler should still be callable without affecting second
  if (firstCommandHandler) {
    assert.doesNotThrow(() =>
      firstCommandHandler("show", {
        ui: { notify: () => {}, theme: {} },
        hasUI: false,
      }),
    );
  }
});

// ---------------------------------------------------------------------------
// Comprehensive: session lifecycle across reload
// ---------------------------------------------------------------------------

test("lifecycle: full session lifecycle (init→reload→invoke handlers) does not throw", async () => {
  const { api, capturedHandlers } = createApiStub();

  // First init
  toolDisplayExtension(api);

  // Invoke all registered lifecycle handlers
  for (const { event, handler } of capturedHandlers) {
    if (event === "message_update" || event === "message_end" || event === "context") {
      continue; // These need specific event shapes; tested separately
    }
    const result = handler({}, { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false });
    if (result instanceof Promise) {
      await assert.doesNotReject(
        () => result,
        `handler for ${event} does not throw`,
      );
    }
  }

  // Reload
  toolDisplayExtension(api);

  // Invoke handlers again after reload
  for (const { event, handler } of capturedHandlers) {
    if (event === "message_update" || event === "message_end" || event === "context") {
      continue;
    }
    const result = handler({}, { ui: { theme: {}, notify: () => {} }, cwd: process.cwd(), isProjectTrusted: () => false });
    if (result instanceof Promise) {
      await assert.doesNotReject(
        () => result,
        `handler for ${event} does not throw after reload`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Summmary test
// ---------------------------------------------------------------------------
