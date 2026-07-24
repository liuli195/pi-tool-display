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
  toolCall: { arguments: unknown; callbackUpdates: string[]; updateEvents: string[]; result: string; eventOrder: string[] };
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
  tuiOutput: {
    cold: string; expandedCold: string; reload: string; expandedReload: string;
    partialNewCall: string; animatedPartialNewCall: string; newCall: string; expandedNewCall: string; collapsedNewCall: string;
    errorNewCall: string; expandedErrorNewCall: string; collapsedErrorNewCall: string;
  };
  lifecycle: { reloads: number; stableWrappers: boolean; wrappersAfterDispose: number; descriptorsRestored: boolean; timerBaseline: number; timersWhilePartial: number; timersAfterCompletion: number; timersAfterDispose: number };
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
  let runtime: any;
  let mode: any;
  let disposed = false;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({
      searchOutputMode: outputMode,
      readOutputMode: outputMode === "count" ? "summary" : outputMode,
      previewLines: 1,
      showTruncationHints: true,
      customToolOverrides: Object.fromEntries(["generic_fixture", "mcp", "mcp_direct_fixture"].map(name => [name, {
        enabled: true,
        kind: name === "generic_fixture" ? "generic" : "mcp",
        outputMode: outputMode === "count" ? "summary" : outputMode,
        overrideCallRenderer: false,
      }])),
    }));
    const mcpServerPath = join(agentDir, "contract-mcp-server.mjs");
    const mcpSdkRoot = resolve(import.meta.dirname, "..", "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    await writeFile(mcpServerPath, `import { McpServer } from ${JSON.stringify(pathToFileURL(join(mcpSdkRoot, "server", "mcp.js")).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(join(mcpSdkRoot, "server", "stdio.js")).href)};
const server = new McpServer({ name: "pi-tool-display-contract", version: "1.0.0" });
server.registerTool("mcp_proxy_fixture", { description: "Real MCP proxy fixture" }, async () => ({ content: [{ type: "text", text: "mcp proxy first line\\nmcp proxy second line\\nmcp proxy third line" }] }));
server.registerTool("mcp_direct_fixture", { description: "Real MCP direct fixture" }, async () => ({ content: [{ type: "text", text: "mcp direct first line\\nmcp direct second line\\nmcp direct third line\\nmcp direct fourth line" }] }));
await server.connect(new StdioServerTransport());
`);
    const mcpDefinition = { command: process.execPath, args: [mcpServerPath], directTools: ["mcp_direct_fixture"], exposeResources: false };
    const adapterRoot = resolve(import.meta.dirname, "..", "..", "node_modules", "pi-mcp-adapter");
    const { computeServerHash } = await import(pathToFileURL(join(adapterRoot, "metadata-cache.ts")).href);
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: { contract: mcpDefinition },
      settings: { toolPrefix: "none" },
    }));
    await writeFile(join(agentDir, "mcp-cache.json"), JSON.stringify({ version: 1, servers: { contract: {
      configHash: computeServerHash(mcpDefinition), cachedAt: Date.now(), resources: [], tools: [
        { name: "mcp_proxy_fixture", description: "Real MCP proxy fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        { name: "mcp_direct_fixture", description: "Real MCP direct fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ],
    } } }));
    const genericExtensionPath = join(agentDir, "generic-fixture.js");
    await writeFile(genericExtensionPath, `export default function (pi) { pi.registerTool({
  name: "generic_fixture", label: "Generic fixture", description: "Pi loader direct registration fixture",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: "text", text: "generic first line\\ngeneric second line" }], details: {} }; }
}); }\n`);
    const observerPath = join(agentDir, "thinking-observer.js");
    await writeFile(observerPath, `export default function (pi) {
  for (const type of ["message_update", "message_end", "context"])
    pi.on(type, event => globalThis.__piToolDisplayThinkingEvents.push(JSON.stringify({ type, event })));
}\n`);
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
    const probes: Record<string, { updates: string[]; arguments?: unknown }> = Object.fromEntries(["read", "find", "ls", "edit", "write"].map((name) => [name, { updates: [] }]));
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
          additionalExtensionPaths: withExtension
            ? [join(adapterRoot, "index.ts"), genericExtensionPath, entry, observerPath]
            : [join(adapterRoot, "index.ts"), genericExtensionPath, observerPath],
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
    runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager });
    const definitionsInitialized = new Map(runtime.session.getAllTools().map((tool: any) => [tool.name, runtime.session.getToolDefinition(tool.name)]));
    runtime.session.setActiveToolsByName(runtime.session.getActiveToolNames().filter((name: string) => name !== "find" && name !== "ls"));
    const activeToolNamesAtStartup = runtime.session.getActiveToolNames();
    mode = new pi.InteractiveMode(runtime) as any;
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

    runtime.session.setActiveToolsByName([...new Set([...runtime.session.getActiveToolNames(), "read", "find", "ls", "edit", "write"])]);
    const calls = [
      { id: "contract-new-read", name: "read", arguments: { path: "fixture.txt" } },
      { id: "contract-new-find", name: "find", arguments: { pattern: "*.txt", path: "." } },
      { id: "contract-new-ls", name: "ls", arguments: { path: "." } },
      { id: "contract-new-edit", name: "edit", arguments: { path: "fixture.txt", oldText: "old line", newText: "new line", oldStart: 7, newStart: 7 } },
      { id: "contract-new-write", name: "write", arguments: { path: "written.txt", content: "new first line\nnew second line\n" } },
      { id: "contract-new-generic", name: "generic_fixture", arguments: {} },
      { id: "contract-new-proxy", name: "mcp", arguments: { tool: "mcp_proxy_fixture", args: "{}" } },
      { id: "contract-new-direct", name: "mcp_direct_fixture", arguments: {} },
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
    disposed = true;
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
      toolCalls: calls.filter(({ name }) => probes[name]).map((call) => ({
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
    return observation as unknown as RunObservation & { actionsBeforeFirstOutput: string[] };
  } finally {
    try {
      mode?.stop();
      if (runtime && !disposed) await runtime.dispose();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(agentDir, { recursive: true, force: true });
    }
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
    { id: "contract-cold-edit", name: "edit", arguments: { path: "fixture.txt", oldText: "old cold", newText: "new cold", oldStart: 12, newStart: 12 }, text: "Edited fixture.txt", details: { diff: "@@ -12,1 +12,1 @@\n- 12#AA:old cold\n+ 12#BB:new cold" } },
    { id: "contract-cold-write", name: "write", arguments: { path: "written.txt", content: "cold first line\ncold second line\n" }, text: "Wrote written.txt", details: {} },
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
  const restoredFixtures = [
    ["generic_fixture", {}, "generic first line\ngeneric second line"],
    ["mcp", { tool: "mcp_proxy_fixture", args: "{}" }, "mcp proxy first line\nmcp proxy second line\nmcp proxy third line"],
    ["mcp_direct_fixture", {}, "mcp direct first line\nmcp direct second line\nmcp direct third line\nmcp direct fourth line"],
  ] as const;
  for (const [index, [name, arguments_, output]] of restoredFixtures.entries()) {
    seed.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `contract-cold-${index}`, name, arguments: arguments_ }],
      api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 3 + index * 2,
    });
    seed.appendMessage({
      role: "toolResult", toolCallId: `contract-cold-${index}`, toolName: name,
      content: [{ type: "text", text: output }], isError: false, timestamp: 4 + index * 2,
    });
  }
  const lifecycleResults = [
    { id: "contract-old-schema", text: "old-schema result preserved", isError: false, content: [{ type: "text", text: "old-schema result preserved" }] },
    { id: "contract-aborted", text: "aborted result preserved", isError: true, content: [{ type: "text", text: "aborted result preserved" }] },
    { id: "contract-image", text: "image-bearing result preserved", isError: false, content: [{ type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" }, { type: "text", text: "image-bearing result preserved" }] },
  ];
  for (const [index, fixture] of lifecycleResults.entries()) {
    seed.appendMessage({
      role: "assistant", content: [{ type: "toolCall", id: fixture.id, name: "generic_fixture", arguments: { schema: fixture.id === "contract-old-schema" ? "old" : "current" } }],
      api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 20 + index * 2,
    });
    seed.appendMessage({ role: "toolResult", toolCallId: fixture.id, toolName: "generic_fixture", content: fixture.content, isError: fixture.isError, timestamp: 21 + index * 2 });
  }
  seed.appendThinkingLevelChange("medium");
  const sessionJsonl = `${(seed as any).fileEntries.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
  const createTools = (probes: Record<string, { updates: string[]; arguments?: unknown }>) => {
    const outputs: Record<string, string> = {
      read: "contract read final first line\ncontract read final second line\ncontract read final third line",
      find: "new-first.txt\nnew-second.txt\nnew-third.txt",
      ls: "new-alpha.txt\nnew-beta.txt\nnew-gamma.txt",
      edit: "Edited fixture.txt",
      write: "Wrote written.txt",
    };
    const fixture = (name: string) => ({
      name, label: `Third-party ${name}`, description: `Deterministic same-name ${name} contract tool`,
      sourceInfo: { source: "local", path: `contract-third-party-${name}.ts` },
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: async (_id: string, args: unknown, _signal: unknown, onUpdate: (result: unknown) => void) => {
        probes[name].arguments = args;
        const update = `contract ${name} streaming output`;
        probes[name].updates.push(update);
        onUpdate({ content: [{ type: "text", text: update }], details: {} });
        return { content: [{ type: "text", text: outputs[name] }], details: name === "read" ? { truncation: { truncated: true, originalLines: 9 } } : name === "edit" ? { diff: "@@ -7,1 +7,1 @@\n-  7#CC:old line\n+  7#DD:new line" } : name === "write" ? { patch: "@@ -4,1 +4,1 @@\n-  4#EE:old supplied\n+  4#FF:new supplied" } : {} };
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

interface ToolProbe { updates: string[]; arguments?: unknown; release?: () => void; calls: number }

async function runBashScenario(runtimeRoot: string, withExtension: boolean, sessionJsonl: string, outputMode: "hidden" | "count" | "preview" | "full" | "summary", createTools: (probe: ToolProbe) => any[], toolName = "grep", injectFailureAfterIntervalInstrumentation = false, injectPreUpdateRender = false): Promise<RunObservation & { actionsBeforeFirstOutput: string[] }> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const hostPrototype = pi.ToolExecutionComponent.prototype;
  const pristineHostDescriptors = Object.getOwnPropertyDescriptors(hostPrototype);
  const hostStateKey = Symbol.for("pi-tool-display.piHostAdapter.v1");
  const wrapperCount = () => Object.getOwnPropertyDescriptor(hostPrototype, hostStateKey) ? 1 : 0;
  const validWrapper = () => {
    const state = (hostPrototype as any)[hostStateKey];
    return !state || (hostPrototype.getCallRenderer === state.patchedCall && hostPrototype.getResultRenderer === state.patchedResult);
  };
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify(toolName === "bash"
      ? { bashCommandMode: outputMode, bashCommandPreviewLines: 1, bashOutputMode: "preview", previewLines: 1, bashErrorOutputMode: "preview", bashErrorPreviewLines: 1 }
      : { searchOutputMode: outputMode, previewLines: 1 }));
    const observerPath = join(agentDir, "thinking-observer.js");
    await writeFile(observerPath, `export default function (pi) {
  for (const type of ["message_update", "message_end", "context"])
    pi.on(type, event => globalThis.__piToolDisplayThinkingEvents.push(JSON.stringify({ type, event })));
}\n`);
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
    const probeObservation: ToolProbe = { updates: [], calls: 0 };
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
    let renderPasses = 0;
    const renderWaiters: Array<{ after: number; done: () => void }> = [];
    const doRender = mode.ui.doRender;
    mode.ui.doRender = function (...args: unknown[]) {
      const result = doRender.apply(this, args);
      renderPasses++;
      const ready = renderWaiters.filter(({ after }) => renderPasses > after);
      for (const waiter of ready) renderWaiters.splice(renderWaiters.indexOf(waiter), 1);
      for (const waiter of ready) waiter.done();
      return result;
    };
    const waitForRenderAfter = (after: number) => renderPasses > after ? Promise.resolve() : new Promise<void>((done) => renderWaiters.push({ after, done }));
    if (mode.themeController) {
      track("theme", mode.themeController, "setThemeName");
      track("theme", mode.themeController, "setThemeInstance");
      track("theme", mode.themeController, "preview");
    }
    const rendersBeforeInit = renderPasses;
    await mode.init();
    mode.ui.doRender();
    await waitForRenderAfter(rendersBeforeInit);
    const cold = terminal.output;
    terminal.take();
    const actionsAtFirstOutput = [...actionsBeforeFirstOutput];
    const rendersBeforeExpandCold = renderPasses;
    mode.toggleToolOutputExpansion();
    mode.ui.doRender();
    await waitForRenderAfter(rendersBeforeExpandCold);
    const expandedCold = terminal.take();

    mode.toggleToolOutputExpansion();
    terminal.take();
    let stableWrappers = wrapperCount() === (withExtension ? 1 : 0) && validWrapper();
    let reload = "";
    for (let reloadIndex = 0; reloadIndex < 3; reloadIndex++) {
      pristineProducers.push(snapshotCallbackProducer(runtime.session.agent));
      const rendersBeforeReload = renderPasses;
      await mode.handleReloadCommand();
      initializedProducers.push(snapshotCallbackProducer(runtime.session.agent));
      stableWrappers &&= wrapperCount() === (withExtension ? 1 : 0) && validWrapper();
      mode.ui.doRender();
      await waitForRenderAfter(rendersBeforeReload);
      reload = terminal.take();
    }
    const rendersBeforeExpandReload = renderPasses;
    mode.toggleToolOutputExpansion();
    mode.ui.doRender();
    await waitForRenderAfter(rendersBeforeExpandReload);
    const expandedReload = terminal.take();
    mode.toggleToolOutputExpansion();
    terminal.take();

    let toolCallId = "contract-new-call";
    const args = toolName === "bash" ? { command: "contract bash command with enough words to wrap across several terminal lines ".repeat(4).trim(), timeout: 17 } : { pattern: "contract", path: "." };
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const animationTimers = new Set<ReturnType<typeof setInterval>>();
    const intervalTicks: Array<() => void> = [];
    globalThis.setInterval = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const timer = realSetInterval((...callbackArgs: any[]) => {
        callback(...callbackArgs);
        if (delay === 200) intervalTicks.shift()?.();
      }, delay === 200 ? 5 : delay, ...args);
      if (delay === 200) animationTimers.add(timer);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
      animationTimers.delete(timer);
      return realClearInterval(timer);
    }) as typeof clearInterval;
    let runtimeDisposed = false;
    let unsubscribe = () => {};
    try {
    const timerBaseline = animationTimers.size;
    const waitForIntervalTick = () => new Promise<void>((done) => intervalTicks.push(done));
    const observedEvents: any[] = [];
    let resolveToolUpdate!: (renderGeneration: number) => void;
    const toolUpdate = new Promise<number>((done) => { resolveToolUpdate = done; });
    unsubscribe = runtime.session.subscribe((event: any) => {
      if (event.toolCallId === toolCallId) {
        observedEvents.push(event);
        if (injectPreUpdateRender && event.type === "tool_execution_start") mode.ui.doRender();
        if (event.type === "tool_execution_update") resolveToolUpdate(renderPasses);
      }
    });
    const ai = await importRuntimePackage(root, "pi-ai");
    const modelInvocations: string[] = [];
    const callbackInvocations: Array<Record<string, Function>> = [];
    let response = 0;
    installDeterministicStream(runtime.session.agent, () => {
      const stream = new ai.AssistantMessageEventStream();
      const toolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
      const invokesTool = response++ % 2 === 0;
      const message = {
        role: "assistant", content: invokesTool ? [toolCall] : [{ type: "text", text: "done" }],
        api: "contract", provider: "contract", model: "contract", stopReason: invokesTool ? "toolUse" : "stop",
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
    let partialNewCall = "", animatedPartialNewCall = "", newCall = "", expandedNewCall = "", collapsedNewCall = "";
    let errorNewCall = "", expandedErrorNewCall = "", collapsedErrorNewCall = "";
    let timersWhilePartial = timerBaseline, timersAfterCompletion = timerBaseline;
    let prompt: Promise<void>;
    try {
      prompt = runtime.session.agent.prompt("run contract probe");
      const renderGenerationAtUpdate = await toolUpdate;
      await waitForRenderAfter(renderGenerationAtUpdate);
      partialNewCall = terminal.take();
      timersWhilePartial = animationTimers.size;
      if (animationTimers.size > timerBaseline) {
        const rendersBeforeAnimation = renderPasses;
        await waitForIntervalTick();
        await waitForRenderAfter(rendersBeforeAnimation);
        animatedPartialNewCall = terminal.take();
      }
      const rendersBeforeCompletion = renderPasses;
      probeObservation.release?.();
      await prompt;
      mode.ui.doRender();
      await waitForRenderAfter(rendersBeforeCompletion);
      newCall = terminal.take();
      timersAfterCompletion = animationTimers.size;
      const rendersBeforeExpandNew = renderPasses;
      mode.toggleToolOutputExpansion();
      mode.ui.doRender();
      await waitForRenderAfter(rendersBeforeExpandNew);
      expandedNewCall = terminal.take();
      const rendersBeforeCollapseNew = renderPasses;
      mode.toggleToolOutputExpansion();
      mode.ui.doRender();
      await waitForRenderAfter(rendersBeforeCollapseNew);
      collapsedNewCall = terminal.take();
      if (toolName === "bash") {
        toolCallId = "contract-new-call-error";
        const rendersBeforeError = renderPasses;
        await runtime.session.agent.prompt("run failing contract probe");
        mode.ui.doRender();
        await waitForRenderAfter(rendersBeforeError);
        errorNewCall = terminal.take();
        const rendersBeforeExpandError = renderPasses;
        mode.toggleToolOutputExpansion();
        mode.ui.doRender();
        await waitForRenderAfter(rendersBeforeExpandError);
        expandedErrorNewCall = terminal.take();
        const rendersBeforeCollapseError = renderPasses;
        mode.toggleToolOutputExpansion();
        mode.ui.doRender();
        await waitForRenderAfter(rendersBeforeCollapseError);
        collapsedErrorNewCall = terminal.take();
      }
    } finally {
      Date.now = realNow;
    }
    unsubscribe();
    unsubscribe = () => {};
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
    runtimeDisposed = true;
    if (injectFailureAfterIntervalInstrumentation) throw new Error("injected failure after interval instrumentation");
    const timersAfterDispose = animationTimers.size;
    const wrappersAfterDispose = wrapperCount();
    const restoredHostDescriptors = Object.getOwnPropertyDescriptors(hostPrototype);
    const descriptorsRestored = Reflect.ownKeys(pristineHostDescriptors).every((key) => {
      const before = (pristineHostDescriptors as any)[key] as PropertyDescriptor;
      const after = (restoredHostDescriptors as any)[key] as PropertyDescriptor;
      return after && before.value === after.value && before.get === after.get && before.set === after.set && before.configurable === after.configurable && before.enumerable === after.enumerable && before.writable === after.writable;
    });
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
    const primaryEvents = observedEvents.filter(({ toolCallId: id }) => id === "contract-new-call");
    const endEvent = primaryEvents.find(({ type }) => type === "tool_execution_end");
    if (!endEvent) throw new Error(`Unsupported Pi event shape: expected tool_execution_end, received ${serialize(observedEvents.map(({ type }) => type))}`);
    const completeSerializedSessionBytes = await readFile(sessionFile, "utf8");
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: definitions.map(({ name, pristine, initialized, disposed }: any) => ({ name, pristine: pristine.execute, initialized: initialized.execute, disposed: disposed.execute })),
      toolCall: {
        arguments: probeObservation.arguments,
        callbackUpdates: probeObservation.updates,
        updateEvents: primaryEvents.filter(({ type }) => type === "tool_execution_update").map(({ partialResult }) => partialResult.content[0].text),
        result: endEvent.result.content[0].text,
        eventOrder: primaryEvents.map(({ type }) => type.replace("tool_execution_", "")),
      },
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
      tuiOutput: { cold, expandedCold, reload, expandedReload, partialNewCall, animatedPartialNewCall, newCall, expandedNewCall, collapsedNewCall, errorNewCall, expandedErrorNewCall, collapsedErrorNewCall },
      lifecycle: { reloads: 3, stableWrappers, wrappersAfterDispose, descriptorsRestored, timerBaseline, timersWhilePartial, timersAfterCompletion, timersAfterDispose },
      actionsBeforeFirstOutput: actionsAtFirstOutput,
    };
    return observation as unknown as RunObservation & { actionsBeforeFirstOutput: string[] };
    } finally {
      try {
        unsubscribe();
        if (!runtimeDisposed) {
          mode.stop();
          await runtime.dispose();
        }
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
        for (const timer of animationTimers) realClearInterval(timer);
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

export async function runBashDisplayContract(runtimeRoot: string, commandMode: "full" | "summary" | "preview", injectFailureAfterIntervalInstrumentation = false, injectPreUpdateRender = false): Promise<PureDisplayContractObservation> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const seed = pi.SessionManager.inMemory(process.cwd(), { id: "contract-bash-session" });
  const command = "contract bash command with enough words to wrap across several terminal lines ".repeat(4).trim();
  const appendCall = (id: string, args: object, text: string, isError: boolean) => {
    seed.appendMessage({
      role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }],
      api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1,
    });
    seed.appendMessage({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 2 });
  };
  appendCall("contract-cold-bash", { command, timeout: 17 }, "contract success first line\ncontract success folded second line\ncontract success folded third line", false);
  appendCall("contract-cold-bash-error", { command: "contract failing command", timeout: 19 }, "contract error first line\ncontract error folded second line\ncontract error folded third line", true);
  const sessionJsonl = `${(seed as any).fileEntries.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
  const createTools = (probe: ToolProbe) => [...pi.createCodingTools(process.cwd()).filter((tool: any) => tool.name !== "bash"), {
    name: "bash", label: "Third-party bash", description: "Deterministic same-name Bash contract tool",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"], additionalProperties: false },
    execute: async (_id: string, args: unknown, _signal: unknown, onUpdate: (result: unknown) => void) => {
      probe.arguments = args;
      probe.calls++;
      if (probe.calls === 1) {
        probe.updates.push("contract streaming output");
        onUpdate({ content: [{ type: "text", text: "contract streaming output\ncontract streaming folded second line" }], details: {} });
        await new Promise<void>((done) => { probe.release = done; });
        return { content: [{ type: "text", text: "contract final output\ncontract final folded second line" }], details: {} };
      }
      return { content: [{ type: "text", text: "contract final error\ncontract error folded second line" }], details: {}, isError: true };
    },
  }];
  const absent = await runBashScenario(runtimeRoot, false, sessionJsonl, commandMode, createTools, "bash", injectFailureAfterIntervalInstrumentation, injectPreUpdateRender);
  const present = await runBashScenario(runtimeRoot, true, sessionJsonl, commandMode, createTools, "bash", false, injectPreUpdateRender);
  return { paths: ["cold", "reload", "new-call"], firstCollapsedOutput: present.tuiOutput.cold, actionsBeforeFirstOutput: present.actionsBeforeFirstOutput, absent, present };
}

