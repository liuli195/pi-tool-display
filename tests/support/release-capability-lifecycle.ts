import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-display-capability-"));
const previous = process.env.PI_CODING_AGENT_DIR;
let handlers = new Map<string, Function[]>();
const entries = Object.entries;

try {
  await mkdir(join(agentDir, "extensions", "pi-tool-display"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "pi-tool-display", "config.json"), JSON.stringify({ readOutputMode: "preview", showRtkCompactionHints: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { createReadTool, initTheme, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  const { default: toolDisplayExtension } = await import("../../src/index.js");
  initTheme(undefined, false);

  let commands: Array<{ name: string }> = [];
  const readTool = createReadTool(process.cwd());
  const api = {
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerCommand() {}, getAllTools() { return [readTool]; }, getCommands() { return commands; },
  } as any;
  let snapshots = 0;
  Object.entries = ((value: object) => {
    if (new Error().stack?.includes("tool-display-resolver")) snapshots++;
    return entries(value);
  }) as typeof Object.entries;

  toolDisplayExtension(api);
  const frame = (id: string) => {
    const row = new ToolExecutionComponent("read", id, { path: "fixture" }, {}, readTool, { requestRender() {} } as any, process.cwd());
    row.updateResult({ content: [{ type: "text", text: "one\ntwo" }], details: { rtkCompaction: { applied: true, techniques: ["dedupe"] } }, isError: false } as any);
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
  try {
    await handlers.get("session_shutdown")?.at(-1)?.({ reason: "reload" });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}
