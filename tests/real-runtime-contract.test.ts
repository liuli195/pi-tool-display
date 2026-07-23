import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";

import { captureModelInvocation, modelVisibleInvocationSnapshot, runPureDisplayContract } from "./support/real-runtime-contract.js";

test("model-visible invocation snapshot is complete and fails closed for host-only or lossy shapes", () => {
  const signal = new AbortController().signal;
  assert.equal(modelVisibleInvocationSnapshot([
    { id: "model", provider: "contract", optional: undefined },
    { systemPrompt: "prompt", messages: [], tools: [] },
    { signal, temperature: 0, headers: { z: "last", a: "first" } },
  ]), '{"context":{"messages":[],"systemPrompt":"prompt","tools":[]},"model":{"id":"model","optional":{"$type":"undefined"},"provider":"contract"},"options":{"headers":{"a":"first","z":"last"},"signal":{"$type":"AbortSignal","aborted":false,"reason":{"$type":"undefined"}},"temperature":0}}');
  assert.equal(modelVisibleInvocationSnapshot([
    {}, { tools: [{ name: "probe", execute() {}, prepareArguments: undefined }] }, {},
  ]), '{"context":{"tools":[{"name":"probe"}]},"model":{},"options":{}}');
  assert.throws(() => modelVisibleInvocationSnapshot([{}, { tools: [{ execute() {}, prepareArguments: "lossy" }] }, {}]), /prepareArguments must be undefined or an own function/);
  assert.equal(modelVisibleInvocationSnapshot([{}, {}, { afterToolCall: function finalize(result: unknown) { return result; } }]),
    '{"context":{},"model":{},"options":{}}');
  assert.throws(() => modelVisibleInvocationSnapshot([{}, {}, { afterToolCall: "lossy" }]), /Unsupported afterToolCall option shape/);
  assert.throws(() => modelVisibleInvocationSnapshot([{}, {}, { callback() {} }]), /nonserializable function/);
  assert.throws(() => modelVisibleInvocationSnapshot([{}, {}, new Map()]), /Unsupported object shape/);

  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  assert.throws(() => modelVisibleInvocationSnapshot([accessor, {}, {}]), /Unsupported accessor/);
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  assert.match(modelVisibleInvocationSnapshot([hidden, {}, {}]), /"hidden":1/);
  assert.throws(() => modelVisibleInvocationSnapshot([{ [Symbol("secret")]: 1 }, {}, {}]), /Unsupported symbol key/);
  const decorated: unknown[] = [];
  Object.defineProperty(decorated, "decoration", { value: true, enumerable: true });
  assert.throws(() => modelVisibleInvocationSnapshot([decorated, {}, {}]), /Unsupported decorated array/);
  const callbackAccessor = Object.defineProperty({}, "afterToolCall", { enumerable: true, get: () => () => {} });
  assert.throws(() => modelVisibleInvocationSnapshot([{}, {}, callbackAccessor]), /Unsupported accessor/);
});

test("real capture path rejects context and tool accessors without invoking them", () => {
  let reads = 0;
  const context = Object.defineProperty({ systemPrompt: "prompt", messages: [], tools: [] }, "systemPrompt", {
    enumerable: true, get: () => { reads++; return "prompt"; },
  });
  assert.throws(() => captureModelInvocation("streamFunction", [{}, context, {}]), /Unsupported accessor/);
  assert.equal(reads, 0);

  const tool = Object.defineProperty({ name: "probe", description: "probe", parameters: {} }, "name", {
    enumerable: true, get: () => { reads++; return "probe"; },
  });
  assert.throws(() => captureModelInvocation("streamFunction", [{}, { systemPrompt: "prompt", messages: [], tools: [tool] }, {}]), /Unsupported accessor/);
  assert.equal(reads, 0);

  const tools = [tool];
  Object.defineProperty(tools, "0", { enumerable: true, get: () => { reads++; return tool; } });
  assert.throws(() => captureModelInvocation("streamFunction", [{}, { systemPrompt: "prompt", messages: [], tools }, {}]), /Unsupported accessor/);
  assert.equal(reads, 0);
});

interface RuntimeMatrixEntry { name: string; version?: string; env: string; required: boolean }
const matrix = JSON.parse(readFileSync(new URL("./runtime-matrix.json", import.meta.url), "utf8")) as RuntimeMatrixEntry[];
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("runtime matrix pins development, Pi 0.81.1, and the declared minimum", () => {
  assert.deepEqual(matrix.map(({ name, version }) => ({ name, version })), [
    { name: "development", version: undefined },
    { name: "pi-0.81.1", version: "0.81.1" },
    { name: "minimum-supported", version: "0.74.0" },
  ]);
  assert.equal(matrix.every(({ required }) => required), true);
  assert.equal(matrix.find(({ name }) => name === "development")?.env, "PI_RUNTIME_DEV_ROOT");
});

for (const entry of matrix) {
  const runtimeRoot = process.env[entry.env];
  const optional = process.env.npm_lifecycle_event === "test:contract:local";
  test(`real Pi runtime contract: ${entry.name}`, { skip: optional && !runtimeRoot ? `${entry.env} is not supplied` : false }, async () => {
    assert.ok(runtimeRoot, `${entry.env} is required (use npm run test:contract:local for optional local runtimes)`);
    const packagePath = runtimeRoot.endsWith("package.json") ? runtimeRoot : resolve(runtimeRoot.endsWith(".js") ? dirname(dirname(runtimeRoot)) : runtimeRoot, "package.json");
    const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (entry.version) assert.equal(packageVersion, entry.version, `${entry.env} must point to Pi ${entry.version}`);

    const observation = await runPureDisplayContract(runtimeRoot);
    const cold = plain(observation.firstCollapsedOutput);

    assert.deepEqual(observation.paths, ["cold", "reload", "new-call"]);
    assert.deepEqual(observation.actionsBeforeFirstOutput, []);
    assert.match(cold, /contract\.txt/);
    if (entry.version === "0.74.0") {
      assert.match(cold, /contract fixture first line/); // 0.74 uses native fallback at this unverified private TUI shape.
    } else {
      assert.doesNotMatch(cold, /contract fixture first line|contract folded (?:second|third) line/);
    }
    assert.match(plain(observation.present.tuiOutput.expandedCold), /contract fixture first line/);
    assert.match(plain(observation.present.tuiOutput.expandedCold), /contract folded third line/);

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
      assert.match(run.modelVisibleInvocations, /contract-cold-read/);
      assert.match(run.modelVisibleInvocations, /contract_probe/);
      assert.match(run.modelVisibleInvocations, /Deterministic contract tool/);
      assert.strictEqual(run.hostCallbacks.producer.initialized, run.hostCallbacks.producer.pristine);
      assert.strictEqual(run.hostCallbacks.producer.disposed, run.hostCallbacks.producer.pristine);
      assert.deepEqual(run.hostCallbacks.producer.initializedDescriptor, run.hostCallbacks.producer.pristineDescriptor);
      assert.deepEqual(run.hostCallbacks.producer.disposedDescriptor, run.hostCallbacks.producer.pristineDescriptor);
      assert.deepEqual(run.hostCallbacks.producer.initializedOwnerDescriptors, run.hostCallbacks.producer.pristineOwnerDescriptors);
      assert.deepEqual(run.hostCallbacks.producer.disposedOwnerDescriptors, run.hostCallbacks.producer.pristineOwnerDescriptors);
      assert.deepEqual(run.hostCallbacks.invocationTypes, Object.fromEntries(run.hostCallbacks.keys.map((key) => [key, "function"])));
      for (const callbacks of run.hostCallbacks.invocations) {
        assert.deepEqual(Object.keys(callbacks).sort(), run.hostCallbacks.keys);
      }
      assert.match(run.sessionSerializationAfterDispose, /contract-cold-read/);
      assert.match(plain(run.tuiOutput.reload), /contract\.txt/);
      assert.match(plain(run.tuiOutput.newCall), /contract_probe/);
    }

    assert.deepEqual(observation.present.activeToolNames, observation.absent.activeToolNames);
    assert.deepEqual(observation.present.ownership, observation.absent.ownership);
    assert.deepEqual(observation.present.toolCall, observation.absent.toolCall);
    assert.equal(observation.present.modelContext, observation.absent.modelContext);
    assert.equal(observation.present.modelVisibleInvocations, observation.absent.modelVisibleInvocations);
    assert.deepEqual(observation.present.hostCallbacks.keys, observation.absent.hostCallbacks.keys);
    assert.equal(observation.present.hostCallbacks.behavior, observation.absent.hostCallbacks.behavior);
    assert.match(observation.present.hostCallbacks.behavior, /get(?:Steering|FollowUp)Messages/);
    assert.deepEqual(observation.present.hostCallbacks.unsupported, observation.absent.hostCallbacks.unsupported);
    assert.ok(observation.present.hostCallbacks.unsupported.every(({ reason }) => reason.includes("pristine Agent config-producer descriptor seam")));
    assert.equal(observation.present.sessionSerializationAfterDispose, observation.absent.sessionSerializationAfterDispose);
  });
}
