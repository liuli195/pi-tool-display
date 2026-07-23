import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRendererCatalog } from "./renderer-catalog.js";
import { createToolDisplayResolver } from "./tool-display-resolver.js";
import type { ToolDisplayConfig } from "./types.js";

export const createPiToolDisplayResolver = (pi: ExtensionAPI, getConfig: () => ToolDisplayConfig) =>
  createToolDisplayResolver(getConfig, createRendererCatalog(pi));
