import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { runPureDisplayContract } from "./support/real-runtime-contract.js";

const runtimeRoots = process.env.PI_RUNTIME_PACKAGE_ROOTS?.split(delimiter).filter(Boolean)
  ?? [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))];
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

for (const runtimeRoot of runtimeRoots) test(`real Pi runtime exposes cold, reload, new-call, and non-interference observations (${runtimeRoot})`, async () => {
  const observation = await runPureDisplayContract(runtimeRoot);
  const cold = plain(observation.firstCollapsedOutput);

  assert.deepEqual(observation.paths, ["cold", "reload", "new-call"]);
  assert.deepEqual(observation.actionsBeforeFirstOutput, []);
  assert.match(cold, /contract\.txt/);
  assert.doesNotMatch(cold, /contract fixture output/);

  assert.ok(observation.present.loadedExtensionPaths.some((path) => path.endsWith("index.ts")));
  assert.ok(observation.absent.loadedExtensionPaths.every((path) => !path.endsWith("index.ts")));
  for (const run of [observation.absent, observation.present]) {
    assert.ok(run.activeToolNames.includes("read"));
    assert.ok(run.ownership.every((tool) => tool.sourceInfo));
    for (const definition of run.definitions) {
      assert.strictEqual(definition.after, definition.before);
      assert.deepEqual(definition.afterDescriptors, definition.beforeDescriptors);
    }
    for (const execution of run.executions) {
      assert.strictEqual(execution.after, execution.before);
      assert.equal(typeof execution.after, "function");
    }
    assert.deepEqual(run.events.map(({ type }) => type), ["tool_execution_start", "tool_execution_end"]);
    assert.match(run.modelContext, /contract-cold-read/);
    assert.match(run.sessionSerialization, /contract-cold-read/);
    assert.match(plain(run.tuiOutput.reload), /contract\.txt/);
    assert.match(plain(run.tuiOutput.newCall), /contract\.txt/);
  }

  assert.deepEqual(observation.present.activeToolNames, observation.absent.activeToolNames);
  assert.deepEqual(observation.present.ownership, observation.absent.ownership);
  assert.deepEqual(observation.present.events, observation.absent.events);
  assert.equal(observation.present.modelContext, observation.absent.modelContext);
  assert.equal(observation.present.sessionSerialization, observation.absent.sessionSerialization);
});
