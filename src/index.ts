import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  CONFIG_DIR_NAME,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  loadToolDisplayConfig,
  readProjectToolDisplayConfig,
  mergeProjectConfig,
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
import { disposeAll, disposeSession, resetDisposed } from "./disposable.js";
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
    disposeSession();
    if (event.reason === "reload" || event.reason === "quit") disposeAll();
  });

  // Global config (written to disk). Project overlay is applied on top at runtime.
  let globalConfig: ToolDisplayConfig = initial.config;
  let config: ToolDisplayConfig = globalConfig;
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
    globalConfig = normalized;
    config = globalConfig;
    effectiveConfig = undefined;

    // Save only global config — project overlay must not leak to disk.
    const saved = saveToolDisplayConfig(globalConfig);
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

    // Reload global config fresh so stale in-memory state from a
    // previous session/project does not bleed into this session.
    const fresh = loadToolDisplayConfig();
    globalConfig = fresh.config;
    config = globalConfig;
    effectiveConfig = undefined;

    // Project-local config overlay: read-only, trusted projects only
    if (ctx.isProjectTrusted()) {
      const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "pi-tool-display", "config.json");
      const projectResult = readProjectToolDisplayConfig(projectConfigPath);
      if (projectResult.config) {
        config = mergeProjectConfig(globalConfig, projectResult.config);
        effectiveConfig = undefined;
      }
      if (projectResult.error) {
        ctx.ui.notify(projectResult.error, "warning");
      }
    }
  });

  pi.on("before_agent_start", async () => {
    refreshCapabilities();
  });
}
