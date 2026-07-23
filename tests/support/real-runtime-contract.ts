import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

interface RunObservation {
  activeToolNames: string[];
  loadedExtensionPaths: string[];
  ownership: Array<{ name: string; sourceInfo: unknown }>;
  definitions: Array<{ name: string; before: object; after: object; beforeDescriptors: PropertyDescriptorMap; afterDescriptors: PropertyDescriptorMap }>;
  executions: Array<{ name: string; before: Function; after: Function }>;
  events: Array<{ type: string; [key: string]: unknown }>;
  modelContext: string;
  sessionSerialization: string;
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

async function run(runtimeRoot: string, withExtension: boolean, sessionJsonl: string, customTools: any[]): Promise<RunObservation & { actionsBeforeFirstOutput: string[] }> {
  const root = packageRoot(resolve(runtimeRoot));
  const pi = await import(pathToFileURL(join(root, "dist", "index.js")).href);
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-contract-"));
  const terminal = new MemoryTerminal();
  try {
    const sessionFile = join(agentDir, "contract.jsonl");
    await writeFile(sessionFile, sessionJsonl);
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
    const definitionsBefore = new Map(runtime.session.getAllTools().map((tool: any) => [tool.name, runtime.session.getToolDefinition(tool.name)]));
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
    const definitionsAfterCold = new Map(runtime.session.getAllTools().map((tool: any) => [tool.name, runtime.session.getToolDefinition(tool.name)]));

    await mode.handleReloadCommand();
    await tick();
    const reload = terminal.take();

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
    const newCall = terminal.take();

    const session = runtime.session;
    const tools = session.getAllTools();
    const definitions = tools.map((tool: any) => {
      const before = definitionsBefore.get(tool.name) as object;
      const after = definitionsAfterCold.get(tool.name) as object;
      return {
        name: tool.name, before, after,
        beforeDescriptors: Object.getOwnPropertyDescriptors(before),
        afterDescriptors: Object.getOwnPropertyDescriptors(after),
      };
    });
    const observation = {
      activeToolNames: session.getActiveToolNames(),
      loadedExtensionPaths: session.resourceLoader.getExtensions().extensions.map((extension: any) => extension.resolvedPath),
      ownership: tools.map((tool: any) => ({ name: tool.name, sourceInfo: tool.sourceInfo })),
      definitions,
      executions: definitions.map(({ name, before, after }: any) => ({ name, before: before.execute, after: after.execute })),
      events: observedEvents,
      modelContext: serialize({ systemPrompt: session.systemPrompt, context: session.sessionManager.buildSessionContext() }),
      sessionSerialization: await readFile(sessionFile, "utf8"),
      tuiOutput: { cold, reload, newCall },
      actionsBeforeFirstOutput: actionsAtFirstOutput,
    };
    mode.stop();
    await runtime.dispose();
    return observation;
  } finally {
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
  const customTools = pi.createCodingTools(process.cwd());
  const absent = await run(runtimeRoot, false, sessionJsonl, customTools);
  const present = await run(runtimeRoot, true, sessionJsonl, customTools);
  return {
    paths: ["cold", "reload", "new-call"],
    firstCollapsedOutput: present.tuiOutput.cold,
    actionsBeforeFirstOutput: present.actionsBeforeFirstOutput,
    absent,
    present,
  };
}
