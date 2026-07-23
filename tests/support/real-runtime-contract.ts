import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

interface ContractOptions { runtimeRoot: string }
interface ToolObservation { name: string; ownership: unknown; definition: unknown; execute: unknown }

export interface PureDisplayContractObservation {
  paths: readonly ["cold", "reload", "new-call"];
  firstCollapsedOutput: string;
  manualInvalidationsBeforeFirstOutput: number;
  activeToolNames: string[];
  loadedExtensionPaths: string[];
  tools: ToolObservation[];
  events: Array<{ type: string; [key: string]: unknown }>;
  modelContext: unknown[];
  sessionSerialization: string;
  tuiOutput: { cold: string; reload: string; newCall: string };
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

export async function runPureDisplayContract({ runtimeRoot }: ContractOptions): Promise<PureDisplayContractObservation> {
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
          additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true,
        },
      });
      const created = await pi.createAgentSessionFromServices({ services, sessionManager: nextManager, sessionStartEvent });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd: process.cwd(), agentDir, sessionManager });
    const mode = new pi.InteractiveMode(runtime) as any;
    mode.ui.terminal = terminal;
    await mode.init();
    mode.ui.requestRender(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cold = terminal.take();

    await mode.handleReloadCommand();
    mode.ui.requestRender(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reload = terminal.take();

    const events = [
      { type: "tool_execution_start", toolCallId: "contract-new-read", toolName: "read", args: { path: "contract.txt" } },
      { type: "tool_execution_end", toolCallId: "contract-new-read", toolName: "read", result: { content: [{ type: "text", text: "contract fixture output" }], details: {} }, isError: false },
    ];
    for (const event of events) await mode.handleEvent(event);
    mode.ui.requestRender(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newCall = terminal.take();

    const session = runtime.session;
    const activeToolNames = session.getActiveToolNames();
    const tools = session.getAllTools().map((tool: any) => {
      const definition = session.getToolDefinition(tool.name);
      return { name: tool.name, ownership: tool.source, definition, execute: definition?.execute };
    });
    const observation = {
      paths: ["cold", "reload", "new-call"] as const,
      firstCollapsedOutput: cold,
      manualInvalidationsBeforeFirstOutput: 0,
      activeToolNames,
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      tools,
      events,
      modelContext: [{ systemPrompt: session.systemPrompt }, ...session.messages],
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
