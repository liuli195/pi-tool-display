import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  sessionSerializationAfterDispose: string;
  tuiOutput: { cold: string; reload: string; newCall: string };
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
  start(_onInput: (data: string) => void, _onResize: () => void) {}
  stop() {}
  async drainInput() {}
  write(data: string) { this.output += data; }
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

async function run(runtimeRoot: string, withExtension: boolean, sessionJsonl: string, createTools: () => any[]): Promise<RunObservation & { actionsBeforeFirstOutput: string[] }> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({ readOutputMode: "hidden" }));
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
    const customTools = createTools();
    const pristineDefinitions = new Map(customTools.map((tool: any) => [tool.name, tool]));
    const sessionManager = pi.SessionManager.open(sessionFile);

    const entry = resolve(import.meta.dirname, "..", "..", "index.ts");
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
    track("theme", mode.themeController, "setThemeName");
    track("theme", mode.themeController, "setThemeInstance");
    track("theme", mode.themeController, "preview");
    await mode.init();
    await waitForOutput(terminal, "contract.txt");
    const cold = terminal.take();
    const actionsAtFirstOutput = [...actionsBeforeFirstOutput];

    await mode.handleReloadCommand();
    await tick();
    const reload = terminal.take();

    const toolCallId = "contract-new-call";
    const args = { path: "contract.txt" };
    const callbackUpdates: string[] = [];
    const observedEvents: any[] = [];
    const unsubscribe = runtime.session.subscribe((event: any) => {
      if (event.toolCallId === toolCallId) observedEvents.push(event);
    });
    runtime.session._emit({ type: "tool_execution_start", toolCallId, toolName: "contract_probe", args });
    const probe = runtime.session.getToolDefinition("contract_probe");
    const result = await probe.execute(toolCallId, args, undefined, (partial: any) => {
      const text = partial.content[0].text;
      callbackUpdates.push(text);
      runtime.session._emit({ type: "tool_execution_update", toolCallId, toolName: "contract_probe", args, partialResult: partial });
    });
    runtime.session._emit({ type: "tool_execution_end", toolCallId, toolName: "contract_probe", result, isError: false });
    await waitForOutput(terminal, "contract_probe");
    unsubscribe();
    const newCall = terminal.take();

    const session = runtime.session;
    const tools = session.getAllTools();
    const initializedSessionDefinitions = new Map(tools.map((tool: any) => [tool.name, session.getToolDefinition(tool.name)]));
    mode.stop();
    await runtime.dispose();
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
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: definitions.map(({ name, pristine, initialized, disposed }: any) => ({ name, pristine: pristine.execute, initialized: initialized.execute, disposed: disposed.execute })),
      toolCall: {
        arguments: observedEvents[0].args,
        callbackUpdates,
        updateEvents: observedEvents.filter(({ type }) => type === "tool_execution_update").map(({ partialResult }) => partialResult.content[0].text),
        result: result.content[0].text,
        eventOrder: observedEvents.map(({ type }) => type.replace("tool_execution_", "")),
      },
      modelContext: serialize({ systemPrompt: session.systemPrompt, context: session.sessionManager.buildSessionContext() }),
      sessionSerializationAfterDispose: await readFile(sessionFile, "utf8"),
      tuiOutput: { cold, reload, newCall },
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
    content: [{ type: "text", text: "contract fixture output" }], isError: false, timestamp: 1,
  });
  seed.appendThinkingLevelChange("medium");
  const sessionJsonl = `${(seed as any).fileEntries.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
  const createTools = () => [...pi.createCodingTools(process.cwd()), {
    name: "contract_probe",
    label: "Contract probe",
    description: "Deterministic contract tool",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    execute: async (_id: string, _args: unknown, _signal: unknown, onUpdate: (result: unknown) => void) => {
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
