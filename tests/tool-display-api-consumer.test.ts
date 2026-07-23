import assert from "node:assert/strict";
import test from "node:test";
import { decorateToolForDisplay, registerRendererAdapter } from "../tool-display-api-consumer.js";

const API = Symbol.for("pi-tool-display.api.v1");
const PENDING = Symbol.for("pi-tool-display.pendingDecorations.v1");

test("compatibility facade registers display intent and returns the exact executable definition unchanged", () => {
  const previous = (globalThis as any)[API];
  const registrations: unknown[] = [];
  (globalThis as any)[API] = { version: 1, registerAdapter: (adapter: unknown) => { registrations.push(adapter); return () => {}; }, decorateTool(tool: unknown, adapter: any) { this.registerAdapter({ id: adapter.id ?? (tool as any).name, toolName: (tool as any).name, ...adapter }); return tool; } };
  const execute = () => "result";
  const tool = Object.freeze({ name: "consumer", parameters: Object.freeze({ type: "object" }), promptSnippet: "prompt", execute });
  try {
    assert.equal(decorateToolForDisplay(tool, { kind: "mcp" }), tool);
    assert.equal(tool.execute, execute);
    assert.deepEqual(registrations, [{ id: "consumer", toolName: "consumer", kind: "mcp" }]);
  } finally { if (previous === undefined) delete (globalThis as any)[API]; else (globalThis as any)[API] = previous; }
});

test("early registration queues display data only and its disposable removes it once", () => {
  const previousApi = (globalThis as any)[API], previousPending = (globalThis as any)[PENDING];
  delete (globalThis as any)[API]; delete (globalThis as any)[PENDING];
  try {
    const dispose = registerRendererAdapter({ id: "early", toolName: "consumer", kind: "generic" });
    assert.deepEqual((globalThis as any)[PENDING], [{ toolName: "consumer", adapter: { id: "early", toolName: "consumer", kind: "generic" } }]);
    dispose(); dispose();
    assert.deepEqual((globalThis as any)[PENDING], []);
  } finally {
    if (previousApi !== undefined) (globalThis as any)[API] = previousApi;
    if (previousPending === undefined) delete (globalThis as any)[PENDING]; else (globalThis as any)[PENDING] = previousPending;
  }
});
