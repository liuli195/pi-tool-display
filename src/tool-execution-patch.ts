import { ToolExecutionComponent, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiToolDisplayResolver } from "./tool-display-runtime.js";
import { installPiHostAdapter } from "./pi-host-adapter.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import type { ToolDisplayConfig } from "./types.js";

export function registerToolExecutionPatch(pi: ExtensionAPI, getConfig: () => ToolDisplayConfig): void {
  const installation = installPiHostAdapter(
    ToolExecutionComponent.prototype,
    createPiToolDisplayResolver(getConfig),
    VERSION,
    message => logToolDisplayDebug(message),
  );
  pi.on("session_shutdown", (event: { reason?: string }) => {
    if (event.reason === "reload" || event.reason === "quit") installation.dispose();
  });
}
