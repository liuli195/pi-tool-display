import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import { registerToolDisplayApi } from "./tool-overrides.js";
import { registerToolExecutionPatch } from "./tool-execution-patch.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import type { ToolDisplayConfig } from "./types.js";
import { registerToolDisplayCommand } from "./config-command.js";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  if (!initial.config.enabled) {
    return;
  }

  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    if (event.reason === "reload") {
      disposeAll();
    }
  });

  let config: ToolDisplayConfig = initial.config;
  let pendingLoadError = initial.error;
  let capabilities: ToolDisplayCapabilities = {
    hasRtkOptimizer: false,
  };
  let effectiveConfig: ToolDisplayConfig | undefined;

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
    effectiveConfig = undefined;
  };

  const getConfig = (): ToolDisplayConfig => config;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    effectiveConfig ??= applyCapabilityConfigGuards(config, capabilities);

  const setConfig = (
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizeToolDisplayConfig(next);
    config = normalized;
    effectiveConfig = undefined;

    const saved = saveToolDisplayConfig(normalized);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }

  };

  registerToolDisplayApi(getEffectiveConfig);
  registerToolExecutionPatch(pi, getEffectiveConfig);
  registerNativeUserMessageBox(pi, getConfig);

  registerToolDisplayCommand(pi, { getConfig, setConfig, getCapabilities });

  pi.on("session_start", async (_event, ctx) => {
    refreshCapabilities();
    if (pendingLoadError) {
      ctx.ui.notify(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }
  });

  pi.on("before_agent_start", async () => {
    refreshCapabilities();
  });
}
