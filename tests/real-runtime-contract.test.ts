import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { runPureDisplayContract } from "./support/real-runtime-contract.js";

const runtimeRoots = process.env.PI_RUNTIME_PACKAGE_ROOTS?.split(delimiter).filter(Boolean)
  ?? [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))];

for (const runtimeRoot of runtimeRoots) test(`real Pi runtime exposes cold, reload, and new-call display observations (${runtimeRoot})`, async () => {
  const observation = await runPureDisplayContract({ runtimeRoot });

  assert.deepEqual(observation.paths, ["cold", "reload", "new-call"]);
  assert.ok(observation.firstCollapsedOutput.length > 0);
  assert.equal(observation.manualInvalidationsBeforeFirstOutput, 0);
  assert.ok(observation.activeToolNames.includes("read"));
  assert.ok(observation.loadedExtensionPaths.some((path) => path.endsWith("index.ts")));
  assert.ok(observation.tools.every((tool) => tool.definition && typeof tool.execute === "function"));
  assert.ok(observation.events.some((event) => event.type === "tool_execution_start"));
  assert.ok(observation.events.some((event) => event.type === "tool_execution_end"));
  assert.ok(observation.modelContext.length > 0);
  assert.ok(observation.sessionSerialization.includes("contract-cold-read"));
  assert.ok(observation.tuiOutput.cold.length > 0);
  assert.ok(observation.tuiOutput.reload.length > 0);
  assert.ok(observation.tuiOutput.newCall.length > 0);
});
