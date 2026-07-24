import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSessionFromServices, createAgentSessionServices, createReadTool, initTheme, SessionManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

import { installPiHostAdapter } from "../src/pi-host-adapter.js";
import { createRendererCatalog } from "../src/renderer-catalog.js";
import { createToolDisplayResolver } from "../src/tool-display-resolver.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.js";

initTheme(undefined, false);
const result = { content: [{ type: "text", text: "one\ntwo" }], details: {} };
const observedMapMethods = ["get", "has", "values", "entries", "keys", Symbol.iterator, "forEach"] as const;

async function loadedRuntime() {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-release-"));
  await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({
    customToolOverrides: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`custom-${index}`, { enabled: true, kind: "generic", outputMode: "summary", overrideCallRenderer: false }])),
  }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const services = await createAgentSessionServices({
    cwd: process.cwd(), agentDir,
    resourceLoaderOptions: { additionalExtensionPaths: [resolve(import.meta.dirname, "..", "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const sessionManager = SessionManager.inMemory(process.cwd());
  const created = await createAgentSessionFromServices({ services, sessionManager });
  return { ...created, services, agentDir, restore: async () => {
    await created.session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  } };
}

async function qualifyRows(...countsToRender: number[]) {
  const runtime = await loadedRuntime();
  const tool = runtime.session.getToolDefinition("read");
  const counts = Object.fromEntries(observedMapMethods.map(String).map(name => [name, 0])) as Record<string, number>;
  const originals = new Map<PropertyKey, Function>();
  for (const key of observedMapMethods) {
    const original = (Map.prototype as any)[key];
    originals.set(key, original);
    (Map.prototype as any)[key] = function (...args: unknown[]) {
      counts[String(key)]++;
      return original.apply(this, args);
    };
  }
  const sessionApis = ["getAllTools", "getActiveToolNames", "getToolDefinition"] as const;
  const apiCounts = Object.fromEntries(sessionApis.map(name => [name, 0])) as Record<string, number>;
  const apiOriginals = new Map<string, Function>();
  for (const name of sessionApis) {
    const original = (runtime.session as any)[name];
    apiOriginals.set(name, original);
    (runtime.session as any)[name] = function (...args: unknown[]) { apiCounts[name]++; return original.apply(this, args); };
  }
  let renderRequests = 0;
  const ui = { requestRender() { renderRequests++; } };
  const hostDescriptors = Object.getOwnPropertyDescriptors(ToolExecutionComponent.prototype);
  const observations = [];
  try {
    for (const count of countsToRender) {
      for (const key of Object.keys(counts)) counts[key] = 0;
      for (const key of Object.keys(apiCounts)) apiCounts[key] = 0;
      renderRequests = 0;
      for (let index = 0; index < count; index++) {
        const row = new ToolExecutionComponent("read", `call-${index}`, { path: "fixture" }, {}, tool, ui as any, process.cwd());
        row.updateResult(result as any);
        row.render(120);
      }
      observations.push({ count, counts: { ...counts }, apiCounts: { ...apiCounts }, renderRequests });
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(ToolExecutionComponent.prototype), hostDescriptors, "row selection must not rebuild the host");
  } finally {
    for (const key of observedMapMethods) (Map.prototype as any)[key] = originals.get(key);
    for (const name of sessionApis) (runtime.session as any)[name] = apiOriginals.get(name);
    await runtime.restore();
    const prototype = ToolExecutionComponent.prototype as any;
    const stateKey = Symbol.for("pi-tool-display.piHostAdapter.v1");
    const state = Object.getOwnPropertyDescriptor(prototype, stateKey)?.value;
    if (state) {
      Object.defineProperty(prototype, "getCallRenderer", state.call);
      Object.defineProperty(prototype, "getResultRenderer", state.result);
      delete prototype[stateKey];
    }
  }
  return observations;
}

test("production loader path performs no registry scans/rebuild loops and linear row selection", async () => {
  const [fiveHundred, thousand] = await qualifyRows(500, 1000);
  for (const observation of [fiveHundred, thousand]) {
    for (const method of ["values", "entries", "keys", "Symbol(Symbol.iterator)", "forEach"])
      assert.equal(observation.counts[method], 0, `${method} must not scan during row rendering`);
    assert.deepEqual(observation.apiCounts, { getAllTools: 0, getActiveToolNames: 0, getToolDefinition: 0 });
    assert.equal(observation.renderRequests, 0, "row selection must not invalidate or rebuild the chat");
  }
  for (const method of ["get", "has"])
    assert.ok(Math.abs(thousand.counts[method] - fiveHundred.counts[method] * 2) <= 32, `${method} must scale linearly per row`);
});

test("real capability lifecycle changes the first frame with one immutable snapshot per epoch", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-capability-"));
  await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({ readOutputMode: "preview", showRtkCompactionHints: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let commands: Array<{ name: string }> = [];
  const handlers = new Map<string, Function[]>();
  const readTool = createReadTool(process.cwd());
  const api = {
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand() {}, getAllTools() { return [readTool]; }, getCommands() { return commands; },
  } as any;
  const entries = Object.entries;
  let snapshots = 0;
  Object.entries = ((value: object) => {
    if (new Error().stack?.includes("tool-display-resolver")) snapshots++;
    return entries(value);
  }) as typeof Object.entries;
  try {
    const { default: toolDisplayExtension } = await import(`../src/index.js?capability=${Date.now()}`);
    toolDisplayExtension(api);
    const frame = (id: string) => {
      const row = new ToolExecutionComponent("read", id, { path: "fixture" }, {}, readTool, { requestRender() {} } as any, process.cwd());
      const value = { content: [{ type: "text", text: "one\ntwo" }], details: { rtkCompaction: { applied: true, techniques: ["dedupe"] } }, isError: false };
      row.updateResult(value as any);
      row.setExpanded(true);
      return row.render(120).join("\n");
    };
    await handlers.get("session_start")?.at(-1)?.({}, { ui: { notify() {} } });
    assert.doesNotMatch(frame("without-rtk"), /compacted by RTK/);
    assert.equal(snapshots, 1);
    commands = [{ name: "rtk" }];
    await handlers.get("before_agent_start")?.at(-1)?.();
    assert.match(frame("with-rtk"), /compacted by RTK/);
    assert.equal(snapshots, 2);
    assert.match(frame("same-epoch"), /compacted by RTK/);
    assert.equal(snapshots, 2);
  } finally {
    Object.entries = entries;
    await handlers.get("session_shutdown")?.at(-1)?.({ reason: "reload" });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("unsupported host shape reports one concise diagnostic and preserves native execution", () => {
  let executions = 0;
  const native = () => "native";
  const host = { getCallRenderer() { return native; }, execute() { executions++; return "executed"; } };
  const before = Object.getOwnPropertyDescriptors(host);
  const diagnostics: string[] = [];
  const resolver = createToolDisplayResolver(() => DEFAULT_TOOL_DISPLAY_CONFIG, createRendererCatalog());

  assert.equal(installPiHostAdapter(host, resolver, "0.81.1", message => diagnostics.push(message)).installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(host), before);
  assert.equal(host.execute(), "executed");
  assert.equal(executions, 1);
  assert.deepEqual(diagnostics, ["pi-tool-display: unsupported Pi 0.81.1 tool-row renderer shape; using native rendering"]);
});
