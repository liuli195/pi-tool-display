import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

interface RunObservation {
  activeToolNames: string[];
  activeToolNamesAtStartup: string[];
  loadedExtensionPaths: string[];
  ownership: Array<{ name: string; sourceInfo: unknown }>;
  definitions: Array<{ name: string; pristine: object; initialized: object; disposed: object; pristineDescriptors: PropertyDescriptorMap; initializedDescriptors: PropertyDescriptorMap; disposedDescriptors: PropertyDescriptorMap }>;
  executions: Array<{ name: string; pristine: Function; initialized: Function; disposed: Function }>;
  toolCalls: Array<{ name: string; arguments: unknown; callbackUpdates: string[]; updateEvents: string[]; result: string; eventOrder: string[] }>;
  modelContext: string;
  modelVisibleInvocations: string;
  thinkingEventsObservedByOtherExtension: string;
  modelVisibleThinkingContext: string;
  completeSerializedSessionBytes: string;
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
      pristineSnapshots: readonly ProducerSnapshot[]; initializedSnapshots: readonly ProducerSnapshot[];
    };
  };
  sessionSerializationAfterDispose: string;
  tuiOutput: { cold: string; expandedCold: string; reload: string; expandedReload: string; newCall: string; expandedNewCall: string };
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

interface ProducerSnapshot {
  readonly key: string;
  readonly value: Function;
  readonly descriptor: Readonly<PropertyDescriptor>;
  readonly ownerDescriptors: Readonly<PropertyDescriptorMap>;
}

function immutableDescriptors(value: object): Readonly<PropertyDescriptorMap> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) Object.freeze((descriptors as any)[key]);
  return Object.freeze(descriptors);
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

function snapshotCallbackProducer(value: object): ProducerSnapshot {
  const producer = callbackProducerDescriptor(value);
  return Object.freeze({
    key: producer.key,
    value: producer.value,
    descriptor: Object.freeze({ ...producer.descriptor }),
    ownerDescriptors: immutableDescriptors(producer.owner),
  });
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

async function probeGeneratedCallbacks(Agent: new () => any, producer: ProducerSnapshot, keys: string[]): Promise<{ behavior: string; unsupported: Array<{ key: string; reason: string }> }> {
  const observations: unknown[] = [];
  const unsupported: Array<{ key: string; reason: string }> = [];
  for (const key of keys) {
    if (!safelyProbeableGeneratedCallbacks.has(key)) {
      unsupported.push({ key, reason: "host contract cannot be safely reproduced; provenance is covered by the pristine Agent config-producer descriptor seam" });
      continue;
    }
    const agent = new Agent();
    const message = { role: "user", content: `contract ${key}`, timestamp: 0 };
    if (key === "getSteeringMessages") agent.steer(message);
    else agent.followUp(message);
    const configEntries = ownDataEntries(producer.value.call(agent), "isolated callback config");
    const callback = configEntries.find(([name]) => name === key)?.[1];
    if (typeof callback !== "function") throw new Error(`Unsupported isolated ${key} callback shape`);
    const args: unknown[] = [];
    const before = agent.hasQueuedMessages();
    let result: unknown = snapshotUndefined;
    let error: unknown = snapshotUndefined;
    try { result = await callback(...args); }
    catch (thrown) { error = thrown instanceof Error ? { name: thrown.name, message: thrown.message } : thrown; }
    observations.push({ key, args, result, error, queue: { before, after: agent.hasQueuedMessages() } });
  }
  return { behavior: JSON.stringify(snapshotValue(observations, "callback observations", new Set())), unsupported };
}

async function run(runtimeRoot: string, withExtension: boolean, sessionJsonl: string, outputMode: "hidden" | "count" | "preview", createTools: (probes: Record<string, { updates: string[]; arguments?: unknown }>) => any[]): Promise<RunObservation & { actionsBeforeFirstOutput: string[] }> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({
      searchOutputMode: outputMode,
      readOutputMode: outputMode === "count" ? "summary" : outputMode,
      previewLines: 1,
      showTruncationHints: true,
      customToolOverrides: Object.fromEntries(["generic_fixture", "mcp_proxy_fixture", "mcp_direct_fixture"].map(name => [name, {
        enabled: true,
        kind: name === "generic_fixture" ? "generic" : "mcp",
        outputMode: outputMode === "count" ? "summary" : outputMode,
        overrideCallRenderer: false,
      }])),
    }));
    const observerPath = join(agentDir, "thinking-observer.js");
    await writeFile(observerPath, `export default function (pi) {
  for (const type of ["message_update", "message_end", "context"])
    pi.on(type, event => globalThis.__piToolDisplayThinkingEvents.push(JSON.stringify({ type, event })));
}\n`);
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
    const probes: Record<string, { updates: string[]; arguments?: unknown }> = Object.fromEntries(["read", "find", "ls", "generic_fixture", "mcp_proxy_fixture", "mcp_direct_fixture"].map((name) => [name, { updates: [] }]));
    const customTools = createTools(probes);
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
    const pristineProducers: ProducerSnapshot[] = [];
    const initializedProducers: ProducerSnapshot[] = [];
    const createRuntime = async ({ cwd, agentDir: nextAgentDir, sessionManager: nextManager, sessionStartEvent }: any) => {
      pristineProducers.push(snapshotCallbackProducer(agentCore.Agent.prototype));
      const services = await pi.createAgentSessionServices({
        cwd, agentDir: nextAgentDir,
        resourceLoaderOptions: {
          additionalExtensionPaths: withExtension ? [entry, observerPath] : [observerPath],
          noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        },
      });
      initializedProducers.push(snapshotCallbackProducer(agentCore.Agent.prototype));
      const created = await pi.createAgentSessionFromServices({
        services, sessionManager: nextManager, sessionStartEvent,
        customTools,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager });
    const definitionsInitialized = new Map(runtime.session.getAllTools().map((tool: any) => [tool.name, runtime.session.getToolDefinition(tool.name)]));
    runtime.session.setActiveToolsByName(runtime.session.getActiveToolNames().filter((name: string) => name !== "find" && name !== "ls"));
    const activeToolNamesAtStartup = runtime.session.getActiveToolNames();
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
    await waitForOutput(terminal, withExtension && outputMode === "count" ? "3 lines" : "contract read first line");
    const cold = terminal.output;
    terminal.take();
    const actionsAtFirstOutput = [...actionsBeforeFirstOutput];
    mode.toggleToolOutputExpansion();
    await waitForOutput(terminal, "contract read first line");
    const expandedCold = terminal.take();

    mode.toggleToolOutputExpansion();
    terminal.take();
    pristineProducers.push(snapshotCallbackProducer(runtime.session.agent));
    await mode.handleReloadCommand();
    initializedProducers.push(snapshotCallbackProducer(runtime.session.agent));
    await waitForOutput(terminal, withExtension && outputMode === "count" ? "3 lines" : outputMode === "hidden" ? "read" : "contract read first line");
    const reload = terminal.take();
    mode.toggleToolOutputExpansion();
    await waitForOutput(terminal, outputMode === "hidden" ? "read" : "contract read third line");
    const expandedReload = terminal.take();
    mode.toggleToolOutputExpansion();
    terminal.take();

    runtime.session.setActiveToolsByName([...new Set([...runtime.session.getActiveToolNames(), "read", "find", "ls"])]);
    const calls = [
      { id: "contract-new-read", name: "read", arguments: { path: "fixture.txt" } },
      { id: "contract-new-find", name: "find", arguments: { pattern: "*.txt", path: "." } },
      { id: "contract-new-ls", name: "ls", arguments: { path: "." } },
      ...["generic_fixture", "mcp_proxy_fixture", "mcp_direct_fixture"].map((name, index) => ({ id: `contract-new-custom-${index}`, name, arguments: { fixture: name } })),
    ];
    const observedEvents: any[] = [];
    const unsubscribe = runtime.session.subscribe((event: any) => {
      if (calls.some(({ id }) => id === event.toolCallId)) observedEvents.push(event);
    });
    const ai = await importRuntimePackage(root, "pi-ai");
    const modelInvocations: string[] = [];
    const callbackInvocations: Array<Record<string, Function>> = [];
    let response = 0;
    installDeterministicStream(runtime.session.agent, () => {
      const stream = new ai.AssistantMessageEventStream();
      const toolCalls = calls.map((call) => ({ type: "toolCall", ...call }));
      const message = {
        role: "assistant", content: response++ === 0 ? toolCalls : [{ type: "text", text: "done" }],
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
    await waitForOutput(terminal, withExtension && outputMode === "count" ? "3 lines" : outputMode === "hidden" ? "ls" : "contract read final first line");
    unsubscribe();
    const newCall = terminal.take();
    mode.toggleToolOutputExpansion();
    await waitForOutput(terminal, outputMode === "hidden" ? "ls" : "contract read final third line");
    const expandedNewCall = terminal.take();
    const callbackKeys = Object.keys(callbackInvocations[0] ?? {}).sort();
    const callbackContract = await probeGeneratedCallbacks(agentCore.Agent, pristineProducers[0], callbackKeys);

    const session = runtime.session;
    const thinkingMessage = {
      role: "assistant", api: "anthropic-messages", provider: "contract", model: "contract",
      content: [{ type: "thinking", thinking: "Thinking: provider-authored bytes" }],
      stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: 2,
    };
    (globalThis as any).__piToolDisplayThinkingEvents = [];
    await (session as any)._extensionRunner.emit({ type: "message_update", message: structuredClone(thinkingMessage), assistantMessageEvent: { type: "thinking_delta", delta: "provider-authored bytes" } });
    await (session as any)._extensionRunner.emit({ type: "message_end", message: structuredClone(thinkingMessage) });
    const modelVisibleThinkingContext = serialize(await (session as any)._extensionRunner.emitContext([structuredClone(thinkingMessage)]));
    const thinkingEventsObservedByOtherExtension = serialize((globalThis as any).__piToolDisplayThinkingEvents);
    const tools = session.getAllTools();
    const initializedSessionDefinitions = new Map(tools.map((tool: any) => [tool.name, session.getToolDefinition(tool.name)]));
    mode.stop();
    await runtime.dispose();
    const disposedProducer = snapshotCallbackProducer(session.agent);
    const pristineProducer = pristineProducers[0];
    const initializedProducer = initializedProducers.at(-1)!;
    if (pristineProducers.some(({ key }) => key !== pristineProducer.key) || initializedProducers.some(({ key }) => key !== pristineProducer.key) || disposedProducer.key !== pristineProducer.key) throw new Error("Pi Agent callback config producer changed during extension lifecycle");
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
    const endEvents = observedEvents.filter(({ type }) => type === "tool_execution_end");
    if (endEvents.length !== calls.length) throw new Error(`Unsupported Pi event shape: expected ${calls.length} tool_execution_end events, received ${serialize(observedEvents.map(({ type }) => type))}`);
    const completeSerializedSessionBytes = await readFile(sessionFile, "utf8");
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      activeToolNamesAtStartup,
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: definitions.map(({ name, pristine, initialized, disposed }: any) => ({ name, pristine: pristine.execute, initialized: initialized.execute, disposed: disposed.execute })),
      toolCalls: calls.map((call) => ({
        name: call.name,
        arguments: probes[call.name].arguments,
        callbackUpdates: probes[call.name].updates,
        updateEvents: observedEvents.filter(({ toolCallId, type }) => toolCallId === call.id && type === "tool_execution_update").map(({ partialResult }) => partialResult.content[0].text),
        result: observedEvents.find(({ toolCallId, type }) => toolCallId === call.id && type === "tool_execution_end").result.content[0].text,
        eventOrder: observedEvents.filter(({ toolCallId }) => toolCallId === call.id).map(({ type }) => type.replace("tool_execution_", "")),
      })),
      modelContext: serialize({ systemPrompt: session.systemPrompt, context: session.sessionManager.buildSessionContext() }),
      modelVisibleInvocations: JSON.stringify(modelInvocations),
      thinkingEventsObservedByOtherExtension,
      modelVisibleThinkingContext,
      completeSerializedSessionBytes,
      hostCallbacks: {
        keys: callbackKeys,
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
          pristineOwnerDescriptors: pristineProducer.ownerDescriptors,
          initializedOwnerDescriptors: initializedProducer.ownerDescriptors,
          disposedOwnerDescriptors: disposedProducer.ownerDescriptors,
          pristineSnapshots: Object.freeze([...pristineProducers]),
          initializedSnapshots: Object.freeze([...initializedProducers]),
        },
      },
      sessionSerializationAfterDispose: completeSerializedSessionBytes,
      tuiOutput: { cold, expandedCold, reload, expandedReload, newCall, expandedNewCall },
      actionsBeforeFirstOutput: actionsAtFirstOutput,
    };
    return observation;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

export async function runPureDisplayContract(runtimeRoot: string, mode: "hidden" | "count" | "preview" = "count"): Promise<PureDisplayContractObservation> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const seed = pi.SessionManager.inMemory(process.cwd(), { id: "contract-session" });
  seed.appendMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Thinking: provider-authored bytes" }],
    api: "anthropic-messages", provider: "contract", model: "contract", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  });
  const historical = [
    { id: "contract-cold-read", name: "read", arguments: { path: "fixture.txt" }, text: "contract read first line\ncontract read second line\ncontract read third line", details: { truncation: { truncated: true, originalLines: 9 } } },
    { id: "contract-cold-find", name: "find", arguments: { pattern: "*.txt", path: "." }, text: "first.txt\nsecond.txt\nthird.txt", details: {} },
    { id: "contract-cold-ls", name: "ls", arguments: { path: "." }, text: "alpha.txt\nbeta.txt\ngamma.txt", details: {} },
  ];
  seed.appendMessage({
    role: "assistant", content: historical.map(({ id, name, arguments: args }) => ({ type: "toolCall", id, name, arguments: args })),
    api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1,
  });
  for (const row of historical) seed.appendMessage({
    role: "toolResult", toolCallId: row.id, toolName: row.name,
    content: [{ type: "text", text: row.text }], details: row.details, isError: false, timestamp: 2,
  });
  for (const [index, name] of ["generic_fixture", "mcp_proxy_fixture", "mcp_direct_fixture"].entries()) {
    seed.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `contract-cold-${index}`, name, arguments: { fixture: name } }],
      api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 3 + index * 2,
    });
    seed.appendMessage({
      role: "toolResult", toolCallId: `contract-cold-${index}`, toolName: name,
      content: [{ type: "text", text: `${name} first line\n${name} folded second line\n${name} folded third line` }], isError: false, timestamp: 4 + index * 2,
    });
  }
  seed.appendThinkingLevelChange("medium");
  const sessionJsonl = `${(seed as any).fileEntries.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
  const createTools = (probes: Record<string, { updates: string[]; arguments?: unknown }>) => {
    const outputs: Record<string, string> = {
      read: "contract read final first line\ncontract read final second line\ncontract read final third line",
      find: "new-first.txt\nnew-second.txt\nnew-third.txt",
      ls: "new-alpha.txt\nnew-beta.txt\nnew-gamma.txt",
      generic_fixture: "generic_fixture final output",
      mcp_proxy_fixture: "mcp_proxy_fixture final output",
      mcp_direct_fixture: "mcp_direct_fixture final output",
    };
    const fixture = (name: string) => ({
      name, label: name, description: `Deterministic ${name} contract tool`,
      sourceInfo: name.endsWith("fixture") ? { owner: `contract-${name}`, source: "contract-direct" } : { source: "local", path: `contract-third-party-${name}.ts` },
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: async (_id: string, args: unknown, _signal: unknown, onUpdate: (result: unknown) => void) => {
        probes[name].arguments = args;
        const update = `contract ${name} streaming output`;
        probes[name].updates.push(update);
        onUpdate({ content: [{ type: "text", text: update }], details: {} });
        return { content: [{ type: "text", text: outputs[name] }], details: name === "read" ? { truncation: { truncated: true, originalLines: 9 } } : {} };
      },
    });
    return [...pi.createCodingTools(process.cwd()).filter((tool: any) => !Object.hasOwn(outputs, tool.name)), ...Object.keys(outputs).map(fixture)];
  };
  const absent = await run(runtimeRoot, false, sessionJsonl, mode, createTools);
  const present = await run(runtimeRoot, true, sessionJsonl, mode, createTools);
  return {
    paths: ["cold", "reload", "new-call"],
    firstCollapsedOutput: present.tuiOutput.cold,
    actionsBeforeFirstOutput: present.actionsBeforeFirstOutput,
    absent,
    present,
  };
}
