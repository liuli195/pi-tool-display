import { logToolDisplayDebug } from "./debug-logger.js";
import { createRendererCatalog } from "./renderer-catalog.js";
import { createToolDisplayResolver, type ToolDisplayDiagnostic, type ToolDisplayDiagnosticSink } from "./tool-display-resolver.js";
import type { ToolDisplayConfig } from "./types.js";

const productionDiagnosticSink = (log: typeof logToolDisplayDebug): ToolDisplayDiagnosticSink => diagnostic => {
  const detail = diagnostic.kind === "adapter-conflict"
    ? ` adapters=${diagnostic.adapters.map(({ id, kind }) => `${id}:${kind}`).join(",")}`
    : diagnostic.kind === "renderer-failure" ? ` slot=${diagnostic.slot}` : "";
  log(`tool-display ${diagnostic.kind} tool=${diagnostic.toolName}${detail}`, diagnostic.error);
};

export const createPiToolDisplayResolver = (
  getConfig: () => ToolDisplayConfig,
  log: typeof logToolDisplayDebug = logToolDisplayDebug,
) => createToolDisplayResolver(getConfig, createRendererCatalog(), productionDiagnosticSink(log));
