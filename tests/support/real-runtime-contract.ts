import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

interface RunObservation {
  activeToolNames: string[];
  loadedExtensionPaths: string[];
  ownership: Array<{ name: string; sourceInfo: unknown }>;
  definitions: Array<{ name: string; pristine: object; initialized: object; disposed: object; pristineDescriptors: PropertyDescriptorMap; initializedDescriptors: PropertyDescriptorMap; disposedDescriptors: PropertyDescriptorMap }>;
  executions: Array<{ name: string; pristine: Function; initialized: Function; disposed: Function }>;
  toolCall: { arguments: unknown; callbackUpdates: string[]; updateEvents: string[]; result: string; eventOrder: string[] };
  modelContext: string;
  modelVisibleInvocations: string;
  hostCallbacks: {
    keys: string[];
    invocationTypes: Record<string, string>;
    invocations: Array<Record<string, Function>>;
    behavior: string;
    unsupported: Array<{ key: string; reason: string }>;
    producer: {
      key: string;
      pristine: Function; initialized: Function; disposed: Function;
      pristineDescriptor: PropertyDescriptor; initializedDescriptor: PropertyDescriptor; disposedDescriptor: PropertyDescriptor;
      pristineOwnerDescriptors: PropertyDescriptorMap; initializedOwnerDescriptors: PropertyDescriptorMap; disposedOwnerDescriptors: PropertyDescriptorMap;
    };
  };
  sessionSerializationAfterDispose: string;
  tuiOutput: { cold: string; expandedCold: string; reload: string; newCall: string };
}

export interface PureDisplayContractObservation {
  paths: readonly ["cold", "reload", "new-call"];
  firstCollapsedOutput: string;
  actionsBeforeFirstOutput: string[];
  absent: RunObservation;
  present: RunObservation;
}

class MemoryTerminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  output = "";
  frames: string[] = [];
  start(_onInput: (data: string) => void, _onResize: () => void) {}
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; this.frames.push(data); }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  take() { const value = this.output; this.output = ""; return value; }
}

function packageRoot(input: string): string {
  if (input.endsWith("package.json")) return dirname(input);
  if (input.endsWith(".js")) return dirname(dirname(input));
  return input;
}

const tick = () => new Promise<void>((done) => setImmediate(done));
async function waitForOutput(terminal: MemoryTerminal, text: string) {
  for (let attempt = 0; attempt < 50 && !terminal.output.includes(text); attempt++) {
    await new Promise((done) => setTimeout(done, 10));
  }
}
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "function" ? `[function:${item.name}]` : item);

async function importRuntimePackage(root: string, name: string) {
  const paths = [join(root, "node_modules", "@earendil-works", name, "dist", "index.js"), join(dirname(dirname(root)), "@earendil-works", name, "dist", "index.js")];
  for (const path of paths) {
    try { await access(path); return import(pathToFileURL(path).href); } catch {}
  }
  throw new Error(`Unsupported Pi package shape: cannot resolve @earendil-works/${name}`);
}

function installDeterministicStream(agent: any, stream: (...args: unknown[]) => unknown, observe: (seam: "streamFunction" | "streamFn", args: unknown[]) => void) {
  const install = (seam: "streamFunction" | "streamFn") => {
    agent[seam] = (...args: unknown[]) => { observe(seam, args); return stream(...args); };
  };
  if (typeof agent?.streamFunction === "function") install("streamFunction");
  else if (typeof agent?.streamFn === "function") install("streamFn");
  else throw new Error("Unsupported Pi Agent shape: expected streamFunction or streamFn");
}

const snapshotUndefined = { $type: "undefined" } as const;

function ownDataEntries(value: object, path: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`Unsupported symbol key at ${path}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) throw new Error(`Unsupported accessor at ${path}.${key}`);
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function snapshotValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === undefined) return snapshotUndefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Unsupported nonserializable number at ${path}`);
    return Object.is(value, -0) ? { $type: "number", value: "-0" } : value;
  }
  if (typeof value !== "object") throw new Error(`Unsupported nonserializable ${typeof value} at ${path}`);
  if (seen.has(value)) throw new Error(`Unsupported nonserializable cycle at ${path}`);
  seen.add(value);
  try {
    if (value instanceof AbortSignal) {
      return { $type: "AbortSignal", aborted: value.aborted, reason: snapshotValue(value.reason, `${path}.reason`, seen) };
    }
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^\d+$/.test(key)))) {
        throw new Error(`Unsupported decorated array at ${path}`);
      }
      if (keys.length !== value.length + 1) throw new Error(`Unsupported sparse or decorated array at ${path}`);
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`Unsupported array descriptor at ${path}[${index}]`);
        return snapshotValue(descriptor.value, `${path}[${index}]`, seen);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`Unsupported object shape at ${path}`);
    const result: Record<string, unknown> = {};
    for (const [key, item] of ownDataEntries(value, path).sort(([a], [b]) => a.localeCompare(b))) {
      result[key] = snapshotValue(item, `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

const hostCallbackOptionKeys = new Set([
  "convertToLlm", "transformContext", "getApiKey", "shouldStopAfterTurn", "prepareNextTurn",
  "getSteeringMessages", "getFollowUpMessages", "beforeToolCall", "afterToolCall", "onPayload", "onResponse",
]);

function projectObject(value: unknown, path: string, exclude: ReadonlySet<string>, replacements: ReadonlyMap<string, unknown> = new Map()): Record<string, unknown> {
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`Unsupported object shape at ${path}`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of ownDataEntries(value, path)) {
    if (exclude.has(key)) continue;
    result[key] = replacements.has(key) ? replacements.get(key) : item;
  }
  return result;
}

function invocationParts(args: unknown[]): { model: unknown; context: object; options: object; contextEntries: Array<[string, unknown]>; optionEntries: Array<[string, unknown]> } {
  if (args.length !== 3) throw new Error(`Unsupported model invocation shape: expected model, context, options; received ${args.length} arguments`);
  const entries = ownDataEntries(args, "invocation arguments");
  const model = entries.find(([key]) => key === "0")?.[1];
  const context = entries.find(([key]) => key === "1")?.[1];
  const options = entries.find(([key]) => key === "2")?.[1];
  if (!context || typeof context !== "object" || !options || typeof options !== "object") throw new Error("Unsupported model invocation context/options shape");
  return { model, context, options, contextEntries: ownDataEntries(context, "context"), optionEntries: ownDataEntries(options, "options") };
}

export function modelVisibleInvocationSnapshot(args: unknown[]): string {
  const { model, context: contextValue, options: optionsValue, contextEntries, optionEntries } = invocationParts(args);
  const toolsEntry = contextEntries.find(([key]) => key === "tools");
  if (toolsEntry && !Array.isArray(toolsEntry[1])) throw new Error("Unsupported model context tools shape");
  const tools = toolsEntry ? arrayDataValues(toolsEntry[1] as unknown[], "context.tools").map((tool, index) => {
    const path = `context.tools[${index}]`;
    const entries = ownDataEntries(tool as object, path);
    const execute = entries.find(([key]) => key === "execute");
    if (!execute || typeof execute[1] !== "function") throw new Error(`Unsupported model tool shape at ${path}: execute must be an own function`);
    const prepare = entries.find(([key]) => key === "prepareArguments");
    if (prepare && prepare[1] !== undefined && typeof prepare[1] !== "function") throw new Error(`Unsupported model tool shape at ${path}: prepareArguments must be undefined or an own function`);
    return projectObject(tool, path, new Set(["execute", "prepareArguments"]));
  }) : undefined;
  const context = projectObject(contextValue, "context", new Set(), new Map([["tools", tools]]));
  for (const [key, value] of optionEntries) {
    if (hostCallbackOptionKeys.has(key) && value !== undefined && typeof value !== "function") throw new Error(`Unsupported ${key} option shape`);
  }
  const options = projectObject(optionsValue, "options", hostCallbackOptionKeys);
  return JSON.stringify(snapshotValue({ model, context, options }, "invocation", new Set()));
}

function arrayDataValues(value: unknown[], path: string): unknown[] {
  const entries = ownDataEntries(value, path);
  const length = entries.find(([key]) => key === "length")?.[1];
  if (typeof length !== "number" || entries.length !== length + 1) throw new Error(`Unsupported sparse or decorated array at ${path}`);
  const indexed = new Map(entries);
  return Array.from({ length }, (_, index) => {
    if (!indexed.has(String(index))) throw new Error(`Unsupported sparse or decorated array at ${path}`);
    return indexed.get(String(index));
  });
}

function callbackProducerDescriptor(value: object): { key: string; value: Function; descriptor: PropertyDescriptor; owner: object } {
  for (const key of ["createLoopConfig", "getConfig"]) {
    for (let owner: object | null = value; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new Error(`Unsupported ${key} producer descriptor`);
      return { key, value: descriptor.value, descriptor, owner };
    }
  }
  throw new Error("Unsupported Pi Agent shape: expected callback config producer");
}

export function captureModelInvocation(seam: "streamFunction" | "streamFn", args: unknown[]): string {
  const { contextEntries } = invocationParts(args);
  const field = (key: string) => contextEntries.find(([name]) => name === key)?.[1];
  const tools = field("tools");
  if (typeof field("systemPrompt") !== "string" || !Array.isArray(field("messages")) || !Array.isArray(tools)) {
    throw new Error(`Unsupported Pi ${seam} context shape: expected systemPrompt, messages, and tools`);
  }
  for (const [index, tool] of arrayDataValues(tools, "context.tools").entries()) {
    const entries = ownDataEntries(tool as object, `context.tools[${index}]`);
    const value = (key: string) => entries.find(([name]) => name === key)?.[1];
    if (typeof value("name") !== "string" || typeof value("description") !== "string" || !value("parameters") || typeof value("parameters") !== "object") {
      throw new Error(`Unsupported Pi ${seam} tool schema shape`);
    }
  }
  return modelVisibleInvocationSnapshot(args);
}

function captureHostCallbacks(args: unknown[]): Record<string, Function> {
  const { optionEntries } = invocationParts(args);
  return Object.fromEntries(optionEntries.filter(([key, value]) => hostCallbackOptionKeys.has(key) && typeof value === "function")) as Record<string, Function>;
}

const safelyProbeableGeneratedCallbacks = new Set(["getSteeringMessages", "getFollowUpMessages"]);

async function probeGeneratedCallbacks(callbacks: Record<string, Function>): Promise<{ behavior: string; unsupported: Array<{ key: string; reason: string }> }> {
  const observations: unknown[] = [];
  const unsupported: Array<{ key: string; reason: string }> = [];
  for (const key of Object.keys(callbacks).sort()) {
    if (!safelyProbeableGeneratedCallbacks.has(key)) {
      unsupported.push({ key, reason: "host contract cannot be safely reproduced; provenance is covered by the pristine Agent config-producer descriptor seam" });
      continue;
    }
    const args: unknown[] = [];
    const order: string[] = [];
    const results: unknown[] = [];
    let thrown: unknown = snapshotUndefined;
    for (let invocation = 0; invocation < 2; invocation++) {
      order.push(`${key}:${invocation}:start`);
      try {
        results.push(await callbacks[key](...args));
        order.push(`${key}:${invocation}:return`);
      } catch (error) {
        order.push(`${key}:${invocation}:throw`);
        thrown = error instanceof Error ? { name: error.name, message: error.message } : error;
        break;
      }
    }
    observations.push({ key, args, results, sideEffects: { repeatedInvocationResults: results }, order, error: thrown });
  }
  return { behavior: JSON.stringify(snapshotValue(observations, "callback observations", new Set())), unsupported };
}

async function run(runtimeRoot: string, withExtension: boolean, sessionJsonl: string, createTools: (probe: { updates: string[]; arguments?: unknown }) => any[]): Promise<RunObservation & { actionsBeforeFirstOutput: string[] }> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({ readOutputMode: "preview", previewLines: 1 }));
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
    const probeObservation: { updates: string[]; arguments?: unknown } = { updates: [] };
    const customTools = createTools(probeObservation);
    const pristineDefinitions = new Map(customTools.map((tool: any) => [tool.name, tool]));
    const sessionManager = pi.SessionManager.open(sessionFile);
    const appendEntry = sessionManager._appendEntry;
    let appendedEntries = 0;
    sessionManager._appendEntry = function (entry: any) {
      entry.id = `contract-entry-${++appendedEntries}`;
      entry.timestamp = "2000-01-01T00:00:00.000Z";
      return appendEntry.call(this, entry);
    };

    const entry = resolve(import.meta.dirname, "..", "..", "index.ts");
    const agentCore = await importRuntimePackage(root, "pi-agent-core");
    const pristineProducer = callbackProducerDescriptor(agentCore.Agent.prototype);
    let initializedProducer = pristineProducer;
    const createRuntime = async ({ cwd, agentDir: nextAgentDir, sessionManager: nextManager, sessionStartEvent }: any) => {
      const services = await pi.createAgentSessionServices({
        cwd, agentDir: nextAgentDir,
        resourceLoaderOptions: {
          additionalExtensionPaths: withExtension ? [entry] : [],
          noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        },
      });
      const created = await pi.createAgentSessionFromServices({
        services, sessionManager: nextManager, sessionStartEvent,
        customTools,
      });
      initializedProducer = callbackProducerDescriptor(created.session.agent);
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager });
    const definitionsInitialized = new Map(runtime.session.getAllTools().map((tool: any) => [tool.name, runtime.session.getToolDefinition(tool.name)]));
    const mode = new pi.InteractiveMode(runtime) as any;
    mode.ui.terminal = terminal;
    const actionsBeforeFirstOutput: string[] = [];
    const track = (name: string, target: any, method: string) => {
      const original = target[method];
      target[method] = function (...args: unknown[]) {
        actionsBeforeFirstOutput.push(name);
        return original.apply(this, args);
      };
    };
    track("ctrl-o", mode, "toggleToolOutputExpansion");
    const requestRender = mode.ui.requestRender;
    mode.ui.requestRender = function (...args: unknown[]) {
      if (args[0] === true) actionsBeforeFirstOutput.push("manual-invalidation");
      return requestRender.apply(this, args);
    };
    if (mode.themeController) {
      track("theme", mode.themeController, "setThemeName");
      track("theme", mode.themeController, "setThemeInstance");
      track("theme", mode.themeController, "preview");
    }
    await mode.init();
    await waitForOutput(terminal, "contract.txt");
    const cold = terminal.frames.find((frame) => frame.includes("contract.txt")) ?? "";
    terminal.take();
    const actionsAtFirstOutput = [...actionsBeforeFirstOutput];
    mode.toggleToolOutputExpansion();
    await waitForOutput(terminal, "contract fixture first line");
    const expandedCold = terminal.take();

    await mode.handleReloadCommand();
    await tick();
    const reload = terminal.take();

    const toolCallId = "contract-new-call";
    const args = { path: "contract.txt" };
    const observedEvents: any[] = [];
    const unsubscribe = runtime.session.subscribe((event: any) => {
      if (event.toolCallId === toolCallId) observedEvents.push(event);
    });
    const ai = await importRuntimePackage(root, "pi-ai");
    const modelInvocations: string[] = [];
    const callbackInvocations: Array<Record<string, Function>> = [];
    let response = 0;
    installDeterministicStream(runtime.session.agent, () => {
      const stream = new ai.AssistantMessageEventStream();
      const toolCall = { type: "toolCall", id: toolCallId, name: "contract_probe", arguments: args };
      const message = {
        role: "assistant", content: response++ === 0 ? [toolCall] : [{ type: "text", text: "done" }],
        api: "contract", provider: "contract", model: "contract", stopReason: response === 1 ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0,
      };
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
      return stream;
    }, (seam, invocationArgs) => {
      modelInvocations.push(captureModelInvocation(seam, invocationArgs));
      callbackInvocations.push(captureHostCallbacks(invocationArgs));
    });
    const realNow = Date.now;
    Date.now = () => 2;
    try {
      await runtime.session.agent.prompt("run contract probe");
    } finally {
      Date.now = realNow;
    }
    await waitForOutput(terminal, "contract_probe");
    unsubscribe();
    const newCall = terminal.take();
    const callbackContract = await probeGeneratedCallbacks(callbackInvocations[0] ?? {});

    const session = runtime.session;
    const tools = session.getAllTools();
    const initializedSessionDefinitions = new Map(tools.map((tool: any) => [tool.name, session.getToolDefinition(tool.name)]));
    mode.stop();
    await runtime.dispose();
    const disposedProducer = callbackProducerDescriptor(session.agent);
    if (initializedProducer.key !== pristineProducer.key || disposedProducer.key !== pristineProducer.key) throw new Error("Pi Agent callback config producer changed during extension lifecycle");
    const disposedDefinitions = new Map(tools.map((tool: any) => [tool.name, session.getToolDefinition(tool.name)]));
    const definitions = [...pristineDefinitions].map(([name, pristine]: any) => {
      const initialized = (definitionsInitialized.get(name) ?? initializedSessionDefinitions.get(name)) as object;
      const disposed = disposedDefinitions.get(name) as object;
      return {
        name, pristine, initialized, disposed,
        pristineDescriptors: Object.getOwnPropertyDescriptors(pristine),
        initializedDescriptors: Object.getOwnPropertyDescriptors(initialized),
        disposedDescriptors: Object.getOwnPropertyDescriptors(disposed),
      };
    });
    const endEvent = observedEvents.find(({ type }) => type === "tool_execution_end");
    if (!endEvent) throw new Error(`Unsupported Pi event shape: expected tool_execution_end, received ${serialize(observedEvents.map(({ type }) => type))}`);
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: definitions.map(({ name, pristine, initialized, disposed }: any) => ({ name, pristine: pristine.execute, initialized: initialized.execute, disposed: disposed.execute })),
      toolCall: {
        arguments: probeObservation.arguments,
        callbackUpdates: probeObservation.updates,
        updateEvents: observedEvents.filter(({ type }) => type === "tool_execution_update").map(({ partialResult }) => partialResult.content[0].text),
        result: endEvent.result.content[0].text,
        eventOrder: observedEvents.map(({ type }) => type.replace("tool_execution_", "")),
      },
      modelContext: serialize({ systemPrompt: session.systemPrompt, context: session.sessionManager.buildSessionContext() }),
      modelVisibleInvocations: JSON.stringify(modelInvocations),
      hostCallbacks: {
        keys: Object.keys(callbackInvocations[0] ?? {}).sort(),
        invocationTypes: Object.fromEntries(Object.entries(callbackInvocations[0] ?? {}).map(([key, value]) => [key, typeof value])),
        invocations: callbackInvocations,
        behavior: callbackContract.behavior,
        unsupported: callbackContract.unsupported,
        producer: {
          key: pristineProducer.key,
          pristine: pristineProducer.value, initialized: initializedProducer.value, disposed: disposedProducer.value,
          pristineDescriptor: pristineProducer.descriptor,
          initializedDescriptor: initializedProducer.descriptor,
          disposedDescriptor: disposedProducer.descriptor,
          pristineOwnerDescriptors: Object.getOwnPropertyDescriptors(pristineProducer.owner),
          initializedOwnerDescriptors: Object.getOwnPropertyDescriptors(initializedProducer.owner),
          disposedOwnerDescriptors: Object.getOwnPropertyDescriptors(disposedProducer.owner),
        },
      },
      sessionSerializationAfterDispose: await readFile(sessionFile, "utf8"),
      tuiOutput: { cold, expandedCold, reload, newCall },
      actionsBeforeFirstOutput: actionsAtFirstOutput,
    };
    return observation;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

export async function runPureDisplayContract(runtimeRoot: string): Promise<PureDisplayContractObservation> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const seed = pi.SessionManager.inMemory(process.cwd(), { id: "contract-session" });
  seed.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "contract-cold-read", name: "read", arguments: { path: "contract.txt" } }],
    api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  });
  seed.appendMessage({
    role: "toolResult", toolCallId: "contract-cold-read", toolName: "read",
    content: [{ type: "text", text: "contract fixture first line\ncontract folded second line\ncontract folded third line" }], isError: false, timestamp: 1,
  });
  seed.appendThinkingLevelChange("medium");
  const sessionJsonl = `${(seed as any).fileEntries.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
  const createTools = (probe: { updates: string[]; arguments?: unknown }) => [...pi.createCodingTools(process.cwd()), {
    name: "contract_probe",
    label: "Contract probe",
    description: "Deterministic contract tool",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (_id: string, args: unknown, _signal: unknown, onUpdate: (result: unknown) => void) => {
      probe.arguments = args;
      probe.updates.push("contract streaming output");
      onUpdate({ content: [{ type: "text", text: "contract streaming output" }], details: {} });
      return { content: [{ type: "text", text: "contract final output" }], details: {} };
    },
  }];
  const absent = await run(runtimeRoot, false, sessionJsonl, createTools);
  const present = await run(runtimeRoot, true, sessionJsonl, createTools);
  return {
    paths: ["cold", "reload", "new-call"],
    firstCollapsedOutput: present.tuiOutput.cold,
    actionsBeforeFirstOutput: present.actionsBeforeFirstOutput,
    absent,
    present,
  };
}
