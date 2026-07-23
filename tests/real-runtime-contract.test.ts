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
      assert.strictEqual(definition.initialized, definition.pristine);
      assert.strictEqual(definition.disposed, definition.pristine);
      assert.deepEqual(definition.initializedDescriptors, definition.pristineDescriptors);
      assert.deepEqual(definition.disposedDescriptors, definition.pristineDescriptors);
    }
    for (const execution of run.executions) {
      assert.strictEqual(execution.initialized, execution.pristine);
      assert.strictEqual(execution.disposed, execution.pristine);
      assert.equal(typeof execution.pristine, "function");
    }
    assert.deepEqual(run.toolCall.arguments, { path: "contract.txt" });
    assert.deepEqual(run.toolCall.callbackUpdates, ["contract streaming output"]);
    assert.deepEqual(run.toolCall.updateEvents, ["contract streaming output"]);
    assert.equal(run.toolCall.result, "contract final output");
    assert.deepEqual(run.toolCall.eventOrder, ["start", "update", "end"]);
    assert.match(run.modelContext, /contract-cold-read/);
    assert.match(run.sessionSerializationAfterDispose, /contract-cold-read/);
    assert.match(plain(run.tuiOutput.reload), /contract\.txt/);
    assert.match(plain(run.tuiOutput.newCall), /contract_probe/);
  }

  assert.deepEqual(observation.present.activeToolNames, observation.absent.activeToolNames);
  assert.deepEqual(observation.present.ownership, observation.absent.ownership);
  assert.deepEqual(observation.present.toolCall, observation.absent.toolCall);
  assert.equal(observation.present.modelContext, observation.absent.modelContext);
  assert.equal(observation.present.sessionSerializationAfterDispose, observation.absent.sessionSerializationAfterDispose);
});
