const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

export function getToolDisplayApi() {
  const api = globalThis[TOOL_DISPLAY_API_KEY];
  return api?.version === 1 && typeof api.registerAdapter === "function" ? api : undefined;
}

function register(adapter, legacyKey) {
  const api = getToolDisplayApi();
  if (api) return api.registerAdapter(adapter);
  const queue = Array.isArray(globalThis[TOOL_DISPLAY_PENDING_DECORATIONS_KEY]) ? globalThis[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] : [];
  if (legacyKey) queue.find((entry) => entry.legacyKey === legacyKey)?.dispose();
  const entry = { toolName: adapter.toolName, adapter: { ...adapter }, legacyKey, disposed: false, liveDispose: undefined };
  entry.dispose = () => {
    if (entry.disposed) return;
    entry.disposed = true;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    entry.liveDispose?.();
  };
  queue.push(entry);
  globalThis[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = queue;
  return entry.dispose;
}

export function registerRendererAdapter(adapter) {
  return register(adapter);
}

export function queueToolDisplayDecoration(tool, adapter) {
  if (!tool?.name) throw new Error("Tool display compatibility registration requires tool.name");
  const intent = { id: adapter?.id ?? tool.name, toolName: tool.name, ...adapter };
  register(intent, `${tool.name}:${intent.id}`);
}

export function decorateToolForDisplay(tool, adapter, options = {}) {
  try {
    const api = getToolDisplayApi();
    if (api?.decorateTool) api.decorateTool(tool, adapter);
    else queueToolDisplayDecoration(tool, adapter);
  } catch (error) {
    if (!options.suppressDecorateErrors) throw error;
  }
  return tool;
}

export function decorateMcpToolForDisplay(tool) {
  return decorateToolForDisplay(tool, { kind: "mcp", overrideExistingRenderers: true });
}
