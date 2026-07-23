import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

interface ContractOptions { runtimeRoot: string }
interface RunObservation {
  activeToolNames: string[];
  loadedExtensionPaths: string[];
  ownership: Array<{ name: string; sourceInfo: unknown }>;
  definitions: Array<{ name: string; serialized: string }>;
  executions: Array<{ name: string; reference: string }>;
  events: Array<{ type: string; [key: string]: unknown }>;
  modelContext: string;
  sessionSerialization: string;
  tuiOutput: { cold: string; reload: string; newCall: string };
}

export interface PureDisplayContractObservation {
  paths: readonly ["cold", "reload", "new-call"];
  firstCollapsedOutput: string;
  manualInvalidationsBeforeFirstOutput: number;
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
const renderChat = (mode: any) => mode.chatContainer.render(120).join("\n");
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "function" ? `[function:${item.name}]` : item);

async function run(runtimeRoot: string, withExtension: boolean): Promise<RunObservation> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  try {
    const sessionManager = pi.SessionManager.inMemory(process.cwd());
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "contract-cold-read", name: "read", arguments: { path: "contract.txt" } }],
      api: "contract", provider: "contract", model: "contract", stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: 0,
    });
    sessionManager.appendMessage({
      role: "toolResult", toolCallId: "contract-cold-read", toolName: "read",
      content: [{ type: "text", text: "contract fixture output" }], isError: false, timestamp: 1,
    });

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
        customTools: pi.createCodingTools(cwd),
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager });
    const mode = new pi.InteractiveMode(runtime) as any;
    mode.ui.terminal = terminal;
    await mode.init();
    await tick();
    const cold = renderChat(mode);
    terminal.take();

    await mode.handleReloadCommand();
    await tick();
    const reload = renderChat(mode);
    terminal.take();

    const events = [
      { type: "tool_execution_start", toolCallId: "contract-new-read", toolName: "read", args: { path: "contract.txt" } },
      { type: "tool_execution_end", toolCallId: "contract-new-read", toolName: "read", result: { content: [{ type: "text", text: "contract fixture output" }], details: {} }, isError: false },
    ];
    const observedEvents: typeof events = [];
    const unsubscribe = runtime.session.subscribe((event: any) => {
      if (event.type.startsWith("tool_execution_")) observedEvents.push(event);
    });
    for (const event of events) runtime.session._emit(event);
    await tick();
    unsubscribe();
    const newCall = renderChat(mode);
    terminal.take();

    const session = runtime.session;
    const tools = session.getAllTools();
    const definitions = tools.map((tool: any) => ({ name: tool.name, serialized: serialize(session.getToolDefinition(tool.name)) }));
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: tools.map((tool: any) => ({ name: tool.name, reference: session.getToolDefinition(tool.name)?.execute?.name ?? "" })),
      events: observedEvents,
      modelContext: serialize({ systemPrompt: session.systemPrompt, context: session.sessionManager.buildSessionContext() }),
      sessionSerialization: session.sessionManager.getEntries().map((entry: unknown) => JSON.stringify(entry)).join("\n"),
      tuiOutput: { cold, reload, newCall },
    };
    mode.stop();
    await runtime.dispose();
    return observation;
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

export async function runPureDisplayContract({ runtimeRoot }: ContractOptions): Promise<PureDisplayContractObservation> {
  const absent = await run(runtimeRoot, false);
  const present = await run(runtimeRoot, true);
  return {
    paths: ["cold", "reload", "new-call"],
    firstCollapsedOutput: present.tuiOutput.cold,
    manualInvalidationsBeforeFirstOutput: 0,
    absent,
    present,
  };
}
