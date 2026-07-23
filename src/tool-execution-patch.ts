import { ToolExecutionComponent, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiToolDisplayResolver } from "./tool-display-runtime.js";
import { installPiHostAdapter } from "./pi-host-adapter.js";
import type { ToolDisplayConfig } from "./types.js";

export function registerToolExecutionPatch(pi: ExtensionAPI, getConfig: () => ToolDisplayConfig): void {
  const installation = installPiHostAdapter(
    ToolExecutionComponent.prototype,
    createPiToolDisplayResolver(pi, getConfig),
    VERSION,
  );
  pi.on("session_shutdown", installation.dispose);
}
