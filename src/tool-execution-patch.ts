import { ToolExecutionComponent, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiToolDisplayResolver } from "./tool-display-runtime.js";
import { installPiHostAdapter } from "./pi-host-adapter.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import { registerSessionCleanup } from "./disposable.js";
import type { ToolDisplayConfig } from "./types.js";

export function registerToolExecutionPatch(_pi: ExtensionAPI, getConfig: () => ToolDisplayConfig): () => void {
  const installation = installPiHostAdapter(
    ToolExecutionComponent.prototype,
    createPiToolDisplayResolver(getConfig),
    VERSION,
    message => logToolDisplayDebug(message),
  );
  let disposed = false;
  let unregister = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unregister();
    installation.dispose();
  };
  unregister = registerSessionCleanup(dispose);
  return dispose;
}
