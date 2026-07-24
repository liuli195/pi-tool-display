import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";

import { captureModelInvocation, modelVisibleInvocationSnapshot, runBashDisplayContract, runPureDisplayContract } from "./support/real-runtime-contract.js";

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
const stableFixturePaths = (ownership: Array<{ name: string; sourceInfo: any }>) => ownership.map(({ name, sourceInfo }) => ({
  name,
  sourceInfo: { ...sourceInfo, path: sourceInfo.path?.replace(/pi-tool-display-contract-[^\\/]+/, "pi-tool-display-contract") },
}));

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
    if (entry.name === "development") {
      const setIntervalBeforeFailure = globalThis.setInterval;
      const clearIntervalBeforeFailure = globalThis.clearInterval;
      await assert.rejects(runBashDisplayContract(runtimeRoot, "preview", true), /injected failure after interval instrumentation/);
      assert.strictEqual(globalThis.setInterval, setIntervalBeforeFailure);
      assert.strictEqual(globalThis.clearInterval, clearIntervalBeforeFailure);

      const raced = await runBashDisplayContract(runtimeRoot, "preview", false, true);
      assert.match(plain(raced.present.tuiOutput.partialNewCall), /contract streaming output/,
        "a render before the tool update must not satisfy partial-frame capture");
    }

    const observation = await runPureDisplayContract(runtimeRoot, "count");
    const cold = plain(observation.firstCollapsedOutput);

    assert.deepEqual(observation.paths, ["cold", "reload", "new-call"]);
    assert.deepEqual(observation.actionsBeforeFirstOutput, []);
    assert.match(cold, /read/);
    assert.match(cold, /3 lines/);
    assert.match(cold, /3 (?:matches|entries|items)/);
    assert.doesNotMatch(cold, /contract read first line|contract read (?:second|third) line|first\.txt|alpha\.txt/);
    assert.match(plain(observation.present.tuiOutput.reload), /3 lines/);
    assert.doesNotMatch(plain(observation.present.tuiOutput.reload), /contract read first line/);
    assert.match(plain(observation.present.tuiOutput.newCall), /3 lines/);
    assert.doesNotMatch(plain(observation.present.tuiOutput.newCall), /contract read final first line/);
    const summaries = [
      ["generic_fixture", "↳ 2 lines returned", "generic first line"],
      ["mcp", "↳ 3 lines returned", "mcp proxy first line"],
      ["mcp_direct_fixture", "↳ 4 lines returned", "mcp direct first line"],
    ] as const;
    for (const frame of [cold, plain(observation.present.tuiOutput.reload), plain(observation.present.tuiOutput.newCall)]) {
      for (const [name, summary, nativeOutput] of summaries) {
        assert.match(frame, new RegExp(`\\b${name}\\b`));
        assert.match(frame, new RegExp(`${summary}(?: • Ctrl\\+O to expand)?`), `${name} must render its exact line-count summary`);
        assert.doesNotMatch(frame, new RegExp(nativeOutput));
      }
    }
    for (const frame of [observation.present.tuiOutput.expandedCold, observation.present.tuiOutput.expandedReload]) {
      const text = plain(frame);
      assert.match(text, /contract read first line/);
      assert.match(text, /contract read third line/);
      assert.match(text, /legacy-runtime result preserved/);
      assert.match(text, /Operation aborted/);
      assert.match(text, /image-bearing result preserved/);
    }
    assert.deepEqual(observation.present.restoredState, { legacyEntry: true, abortedIsError: true, coldImageComponents: 1, reloadImageComponents: 1 }, "real restored TUI rows must retain legacy, aborted, and image lifecycle state");
    assert.deepEqual(observation.absent.restoredState, observation.present.restoredState, "display extension must not alter restored lifecycle state");
    assert.match(plain(observation.present.tuiOutput.expandedNewCall), /contract read final third line/);
    for (const frame of [observation.firstCollapsedOutput, observation.present.tuiOutput.reload]) {
      const text = plain(frame);
      assert.match(text, /edit.*fixture\.txt/);
      assert.doesNotMatch(text, /12#(?:AA|BB):/);
    }
    assert.match(plain(observation.present.tuiOutput.expandedCold), /12#AA.*old cold/);
    assert.match(plain(observation.present.tuiOutput.expandedReload), /12#BB.*new cold/);
    assert.match(plain(observation.present.tuiOutput.newCall), /edit.*fixture\.txt/);
    assert.doesNotMatch(plain(observation.present.tuiOutput.newCall), /7#(?:CC|DD):/);
    assert.match(plain(observation.present.tuiOutput.expandedNewCall), /7#CC.*old line/);
    assert.match(plain(observation.present.tuiOutput.expandedNewCall), /7#DD.*new line/);

    for (const frame of [cold, plain(observation.present.tuiOutput.reload)]) {
      assert.match(frame, /write.*written\.txt.*2 lines/);
      assert.match(frame, /Wrote written\.txt/);
      assert.doesNotMatch(frame, /(?:pending )?(?:create|overwrite)|additions?|deletions?/i);
    }
    assert.match(plain(observation.present.tuiOutput.newCall), /write.*written\.txt.*2 lines/);
    assert.doesNotMatch(plain(observation.present.tuiOutput.newCall), /4#(?:EE|FF):/);
    assert.match(plain(observation.present.tuiOutput.expandedNewCall), /4#EE.*old supplied/);
    assert.match(plain(observation.present.tuiOutput.expandedNewCall), /4#FF.*new supplied/);

    const hidden = await runPureDisplayContract(runtimeRoot, "hidden");
    for (const name of ["generic_fixture", "mcp", "mcp_direct_fixture"]) {
      for (const frame of [hidden.firstCollapsedOutput, hidden.present.tuiOutput.reload, hidden.present.tuiOutput.newCall]) {
        assert.match(plain(frame), new RegExp(`\\b${name}\\b`));
        assert.doesNotMatch(plain(frame), /generic first line|mcp (?:proxy|direct) first line|lines returned/);
      }
    }
    for (const frame of [hidden.firstCollapsedOutput, hidden.present.tuiOutput.reload, hidden.present.tuiOutput.newCall,
      hidden.present.tuiOutput.expandedCold, hidden.present.tuiOutput.expandedReload, hidden.present.tuiOutput.expandedNewCall]) {
      const text = plain(frame);
      assert.match(text, /read|find|ls/);
      assert.doesNotMatch(text, /contract read (?:first|second|third) line|contract read final|first\.txt|alpha\.txt|matches? returned|3 lines/);
    }

    const preview = await runPureDisplayContract(runtimeRoot, "preview");
    for (const output of ["generic first line", "mcp proxy first line", "mcp direct first line"]) {
      for (const frame of [preview.firstCollapsedOutput, preview.present.tuiOutput.reload, preview.present.tuiOutput.newCall])
        assert.match(plain(frame), new RegExp(output));
    }
    for (const frame of [preview.firstCollapsedOutput, preview.present.tuiOutput.reload]) {
      const text = plain(frame);
      assert.match(text, /contract read first line/);
      assert.doesNotMatch(text, /contract read (?:second|third) line/);
    }
    assert.match(plain(preview.present.tuiOutput.newCall), /contract read final first line/);
    for (const frame of [preview.present.tuiOutput.expandedCold, preview.present.tuiOutput.expandedReload])
      assert.match(plain(frame), /contract read third line/);
    assert.match(plain(preview.present.tuiOutput.expandedNewCall), /contract read final third line/);

    const displayExtensionPath = resolve(import.meta.dirname, "..", "index.ts");
    assert.ok(observation.present.loadedExtensionPaths.includes(displayExtensionPath));
    assert.ok(!observation.absent.loadedExtensionPaths.includes(displayExtensionPath));
    for (const run of [observation.absent, observation.present]) {
      assert.ok(run.activeToolNames.includes("read") && run.activeToolNames.includes("find") && run.activeToolNames.includes("ls"));
      assert.ok(run.activeToolNamesAtStartup.includes("read"));
      assert.ok(!run.activeToolNamesAtStartup.includes("find") && !run.activeToolNamesAtStartup.includes("ls"));
      for (const name of ["generic_fixture", "mcp", "mcp_direct_fixture"]) assert.ok(run.activeToolNames.includes(name));
      assert.ok(run.ownership.every((tool) => tool.sourceInfo));
      for (const name of ["generic_fixture", "mcp", "mcp_direct_fixture"]) {
        const source = run.ownership.find(tool => tool.name === name)?.sourceInfo as any;
        assert.notEqual(source?.source, "sdk", `${name} must come through Pi's extension loader`);
        assert.match(source?.path ?? "", name === "generic_fixture" ? /generic-fixture\.js$/ : /pi-mcp-adapter[\\/]index\.ts$/);
      }
      assert.ok(run.definitions.some(({ name }) => name === "edit"));
      assert.ok(run.definitions.some(({ name }) => name === "write"));
      assert.ok(run.executions.some(({ name }) => name === "edit"));
      assert.ok(run.executions.some(({ name }) => name === "write"));
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
      assert.deepEqual(run.toolCalls.map(({ name }) => name), ["read", "find", "ls", "edit", "write"]);
      for (const call of run.toolCalls) {
        assert.deepEqual(call.callbackUpdates, [`contract ${call.name} streaming output`]);
        assert.deepEqual(call.updateEvents, [`contract ${call.name} streaming output`]);
        assert.match(call.result, /new-|contract read final|Edited fixture|Wrote written/);
        assert.deepEqual(call.eventOrder, ["start", "update", "end"]);
      }
      assert.match(run.modelContext, /contract-cold-read/);
      assert.match(run.modelVisibleInvocations, /contract-cold-read/);
      assert.match(run.modelVisibleInvocations, /Deterministic same-name read contract tool/);
      assert.strictEqual(run.hostCallbacks.producer.initialized, run.hostCallbacks.producer.pristine);
      assert.strictEqual(run.hostCallbacks.producer.disposed, run.hostCallbacks.producer.pristine);
      assert.deepEqual(run.hostCallbacks.producer.initializedDescriptor, run.hostCallbacks.producer.pristineDescriptor);
      assert.deepEqual(run.hostCallbacks.producer.disposedDescriptor, run.hostCallbacks.producer.pristineDescriptor);
      assert.deepEqual(run.hostCallbacks.producer.initializedOwnerDescriptors, run.hostCallbacks.producer.pristineOwnerDescriptors);
      assert.deepEqual(run.hostCallbacks.producer.disposedOwnerDescriptors, run.hostCallbacks.producer.pristineOwnerDescriptors);
      assert.equal(run.hostCallbacks.producer.pristineSnapshots.length, 2); // initial load and one real reload
      assert.equal(run.hostCallbacks.producer.initializedSnapshots.length, 2);
      assert.ok(Object.isFrozen(run.hostCallbacks.producer.pristineSnapshots));
      assert.ok(Object.isFrozen(run.hostCallbacks.producer.initializedSnapshots));
      for (const snapshot of [...run.hostCallbacks.producer.pristineSnapshots, ...run.hostCallbacks.producer.initializedSnapshots]) {
        assert.strictEqual(snapshot.value, run.hostCallbacks.producer.pristine);
        assert.deepEqual(snapshot.descriptor, run.hostCallbacks.producer.pristineDescriptor);
        assert.deepEqual(snapshot.ownerDescriptors, run.hostCallbacks.producer.pristineOwnerDescriptors);
        assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.descriptor) && Object.isFrozen(snapshot.ownerDescriptors));
      }
      assert.deepEqual(run.hostCallbacks.invocationTypes, Object.fromEntries(run.hostCallbacks.keys.map((key) => [key, "function"])));
      for (const callbacks of run.hostCallbacks.invocations) {
        assert.deepEqual(Object.keys(callbacks).sort(), run.hostCallbacks.keys);
      }
      assert.match(run.sessionSerializationAfterDispose, /contract-cold-read/);
      assert.match(run.sessionSerializationAfterDispose, /legacy-runtime result preserved/);
      assert.match(run.sessionSerializationAfterDispose, /"stopReason":"aborted"/);
      assert.match(run.sessionSerializationAfterDispose, /"errorMessage":"Request was aborted"/);
      assert.match(run.sessionSerializationAfterDispose, /iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/);
      assert.match(run.sessionSerializationAfterDispose, /"mimeType":"image\/png"/);
      assert.match(plain(run.tuiOutput.reload), /read/);
      assert.match(plain(run.tuiOutput.newCall), /read|find|ls/);
    }

    assert.deepEqual(observation.present.activeToolNames, observation.absent.activeToolNames);
    assert.deepEqual(observation.present.activeToolNamesAtStartup, observation.absent.activeToolNamesAtStartup);
    assert.deepEqual(stableFixturePaths(observation.present.ownership), stableFixturePaths(observation.absent.ownership));
    assert.deepEqual(observation.present.toolCalls, observation.absent.toolCalls);
    assert.equal(observation.present.modelContext, observation.absent.modelContext);
    assert.equal(observation.present.modelVisibleInvocations, observation.absent.modelVisibleInvocations);
    assert.deepEqual(observation.present.hostCallbacks.keys, observation.absent.hostCallbacks.keys);
    assert.equal(observation.present.hostCallbacks.behavior, observation.absent.hostCallbacks.behavior);
    const callbackBehavior = JSON.parse(observation.present.hostCallbacks.behavior);
    assert.ok(callbackBehavior.some(({ key }: any) => /get(?:Steering|FollowUp)Messages/.test(key)));
    assert.ok(callbackBehavior.every(({ args, result, error, queue }: any) =>
      Array.isArray(args) && Array.isArray(result) && error?.$type === "undefined" && queue?.before === true && queue?.after === false));
    assert.ok(callbackBehavior.every((probe: any) => !("sideEffects" in probe) && !("results" in probe)));
    assert.deepEqual(observation.present.hostCallbacks.unsupported, observation.absent.hostCallbacks.unsupported);
    assert.ok(observation.present.hostCallbacks.unsupported.every(({ reason }) => reason.includes("pristine Agent config-producer descriptor seam")));
    assert.equal(typeof observation.absent.thinkingEventsObservedByOtherExtension, "string");
    assert.equal(typeof observation.absent.modelVisibleThinkingContext, "string");
    assert.equal(typeof observation.absent.completeSerializedSessionBytes, "string");
    for (const bytes of [
      observation.absent.thinkingEventsObservedByOtherExtension,
      observation.absent.modelVisibleThinkingContext,
      observation.absent.completeSerializedSessionBytes,
    ]) assert.ok(bytes.includes("Thinking: provider-authored bytes"));
    assert.equal(observation.present.thinkingEventsObservedByOtherExtension, observation.absent.thinkingEventsObservedByOtherExtension);
    assert.equal(observation.present.modelVisibleThinkingContext, observation.absent.modelVisibleThinkingContext);
    assert.equal(observation.present.completeSerializedSessionBytes, observation.absent.completeSerializedSessionBytes);
    assert.equal(observation.present.sessionSerializationAfterDispose, observation.absent.sessionSerializationAfterDispose);

    const bashCommand = "contract bash command with enough words to wrap across several terminal lines ".repeat(4).trim();
    for (const commandMode of ["full", "summary", "preview"] as const) {
      const bash = await runBashDisplayContract(runtimeRoot, commandMode);
      assert.deepEqual(bash.paths, ["cold", "reload", "new-call"]);
      assert.deepEqual(bash.actionsBeforeFirstOutput, []);
      for (const frame of [bash.firstCollapsedOutput, bash.present.tuiOutput.reload]) {
        const text = plain(frame);
        assert.match(text, /contract bash command/);
        assert.match(text, /contract success first line/);
        assert.match(text, /contract error first line/);
        assert.doesNotMatch(text, /contract (?:success|error) folded (?:second|third) line/);
      }
      const partial = plain(bash.present.tuiOutput.partialNewCall);
      assert.match(partial, /contract streaming output/);
      assert.doesNotMatch(partial, /contract streaming folded second line/);
      assert.notEqual(bash.present.tuiOutput.animatedPartialNewCall, "");
      assert.notEqual(plain(bash.present.tuiOutput.animatedPartialNewCall), partial);
      assert.match(plain(bash.present.tuiOutput.newCall), /contract final output/);
      assert.doesNotMatch(plain(bash.present.tuiOutput.newCall), /contract final folded second line/);
      assert.match(plain(bash.present.tuiOutput.expandedNewCall), /contract final folded second line/);
      assert.doesNotMatch(plain(bash.present.tuiOutput.collapsedNewCall), /contract final folded second line/);
      assert.match(plain(bash.present.tuiOutput.errorNewCall), /contract final error/);
      assert.doesNotMatch(plain(bash.present.tuiOutput.errorNewCall), /contract error folded second line/);
      assert.match(plain(bash.present.tuiOutput.expandedErrorNewCall), /contract error folded second line/);
      assert.doesNotMatch(plain(bash.present.tuiOutput.collapsedErrorNewCall), /contract error folded second line/);
      assert.deepEqual(bash.present.lifecycle, {
        reloads: 3, stableWrappers: true, wrappersAfterDispose: 0, descriptorsRestored: true,
        timerBaseline: 0, timersWhilePartial: 1, timersAfterCompletion: 0, timersAfterDispose: 0,
      });
      for (const frame of [bash.present.tuiOutput.expandedCold, bash.present.tuiOutput.expandedReload]) {
        assert.match(plain(frame), /contract success folded third line/);
        assert.match(plain(frame), /contract error folded third line/);
      }
      const commandIsFolded = (frame: string) => /more visual lines/.test(plain(frame).split(/contract (?:success first line|streaming output|final output)/)[0]);
      const folded = commandIsFolded(bash.firstCollapsedOutput);
      assert.equal(commandIsFolded(bash.present.tuiOutput.reload), folded);
      assert.equal(commandIsFolded(bash.present.tuiOutput.newCall), folded);
      assert.equal(commandIsFolded(bash.present.tuiOutput.collapsedNewCall), folded);
      assert.equal(commandIsFolded(bash.present.tuiOutput.errorNewCall), folded);
      assert.equal(commandIsFolded(bash.present.tuiOutput.collapsedErrorNewCall), folded);
      assert.equal(folded, commandMode !== "full");

      for (const run of [bash.absent, bash.present]) {
        assert.ok(run.activeToolNames.includes("bash"));
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
        }
        assert.deepEqual(run.toolCall.arguments, { command: bashCommand, timeout: 17 });
        assert.deepEqual(run.toolCall.callbackUpdates, ["contract streaming output"]);
        assert.deepEqual(run.toolCall.updateEvents, ["contract streaming output\ncontract streaming folded second line"]);
        assert.equal(run.toolCall.result, "contract final output\ncontract final folded second line");
        assert.deepEqual(run.toolCall.eventOrder, ["start", "update", "end"]);
      }
      assert.ok(bash.present.loadedExtensionPaths.some((path) => path.endsWith("index.ts")));
      assert.ok(bash.absent.loadedExtensionPaths.every((path) => !path.endsWith("index.ts")));
      assert.match(bash.present.modelVisibleInvocations, /Deterministic same-name Bash contract tool/);
      assert.deepEqual(bash.present.activeToolNames, bash.absent.activeToolNames);
      assert.deepEqual(bash.present.ownership, bash.absent.ownership);
      assert.deepEqual(bash.present.toolCall, bash.absent.toolCall);
      assert.equal(bash.present.modelContext, bash.absent.modelContext);
      assert.equal(bash.present.modelVisibleInvocations, bash.absent.modelVisibleInvocations);
      assert.equal(bash.present.sessionSerializationAfterDispose, bash.absent.sessionSerializationAfterDispose);
      assert.deepEqual({
        reloads: bash.absent.lifecycle.reloads,
        stableWrappers: bash.absent.lifecycle.stableWrappers,
        wrappersAfterDispose: bash.absent.lifecycle.wrappersAfterDispose,
        descriptorsRestored: bash.absent.lifecycle.descriptorsRestored,
        timersAfterCompletion: bash.absent.lifecycle.timersAfterCompletion,
        timersAfterDispose: bash.absent.lifecycle.timersAfterDispose,
      }, { reloads: 3, stableWrappers: true, wrappersAfterDispose: 0, descriptorsRestored: true, timersAfterCompletion: 0, timersAfterDispose: 0 });
    }
  });
}
