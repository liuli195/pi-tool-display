import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logToolDisplayDebug } from "./debug-logger.js";
import { createRendererCatalog } from "./renderer-catalog.js";
import { createToolDisplayResolver, type ToolDisplayDiagnostic, type ToolDisplayDiagnosticSink } from "./tool-display-resolver.js";
import type { ToolDisplayConfig } from "./types.js";

const productionDiagnosticSink: ToolDisplayDiagnosticSink = diagnostic => {
  const detail = diagnostic.kind === "adapter-conflict"
    ? ` adapters=${diagnostic.adapters.map(({ id, kind }) => `${id}:${kind}`).join(",")}`
    : diagnostic.kind === "renderer-failure" ? ` slot=${diagnostic.slot}` : "";
  logToolDisplayDebug(`tool-display ${diagnostic.kind} tool=${diagnostic.toolName}${detail}`, diagnostic.error);
};

export const createPiToolDisplayResolver = (
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
  onDiagnostic: ToolDisplayDiagnosticSink = productionDiagnosticSink,
) => createToolDisplayResolver(getConfig, createRendererCatalog(pi), onDiagnostic);
