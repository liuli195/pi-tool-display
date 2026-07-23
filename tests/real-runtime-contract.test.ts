import assert from "node:assert/strict";
import test from "node:test";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import { runPureDisplayContract } from "./support/real-runtime-contract.js";

const runtimeRoots = process.env.PI_RUNTIME_PACKAGE_ROOTS?.split(delimiter).filter(Boolean)
  ?? [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))];
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

for (const runtimeRoot of runtimeRoots) test(`real Pi runtime exposes cold, reload, new-call, and non-interference observations (${runtimeRoot})`, async () => {
  const observation = await runPureDisplayContract({ runtimeRoot });
  const cold = plain(observation.firstCollapsedOutput);

  assert.deepEqual(observation.paths, ["cold", "reload", "new-call"]);
  assert.equal(observation.manualInvalidationsBeforeFirstOutput, 0);
  assert.match(cold, /contract\.txt/);
  assert.doesNotMatch(cold, /contract fixture output/);

  assert.ok(observation.present.loadedExtensionPaths.some((path) => path.endsWith("index.ts")));
  assert.ok(observation.absent.loadedExtensionPaths.every((path) => !path.endsWith("index.ts")));
  for (const run of [observation.absent, observation.present]) {
    assert.ok(run.activeToolNames.includes("read"));
    assert.ok(run.ownership.every((tool) => tool.sourceInfo));
    assert.ok(run.definitions.every((tool) => tool.serialized));
    assert.ok(run.executions.every((tool) => tool.reference));
    assert.deepEqual(run.events.map(({ type }) => type), ["tool_execution_start", "tool_execution_end"]);
    assert.match(run.modelContext, /contract-cold-read/);
    assert.match(run.sessionSerialization, /contract-cold-read/);
    assert.match(plain(run.tuiOutput.reload), /contract\.txt/);
    assert.match(plain(run.tuiOutput.newCall), /contract\.txt/);
  }

  assert.deepEqual(observation.present.activeToolNames, observation.absent.activeToolNames);
  assert.equal(observation.present.modelContext, observation.absent.modelContext);
  const sessionMessages = (jsonl: string) => jsonl.split("\n").map((line) => JSON.parse(line).message).filter(Boolean);
  assert.deepEqual(sessionMessages(observation.present.sessionSerialization), sessionMessages(observation.absent.sessionSerialization));
});
