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

  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    disposeSession();
    if (event.reason === "reload" || event.reason === "quit") disposeAll();
  });

  // Global config (written to disk). Project overlay is applied on top at runtime.
  let globalConfig: ToolDisplayConfig = initial.config;
  let mergedConfig: ToolDisplayConfig = globalConfig;
  let pendingLoadError = initial.error;
  let capabilities: ToolDisplayCapabilities = {
    hasRtkOptimizer: false,
  };
  let effectiveConfig: ToolDisplayConfig | undefined;
  let projectOverlay: Partial<ToolDisplayConfig> | undefined;

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
    effectiveConfig = undefined;
  };

  const getConfig = (): ToolDisplayConfig => mergedConfig;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    effectiveConfig ??= applyCapabilityConfigGuards(mergedConfig, capabilities);

  const setConfig = (
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    // Compute delta: what changed relative to the current merged config.
    // Then apply only those changes to globalConfig so project values
    // don't leak to disk.
    const delta: Partial<ToolDisplayConfig> = {};
    for (const key of Object.keys(next) as Array<keyof ToolDisplayConfig>) {
      if (JSON.stringify(next[key]) !== JSON.stringify(mergedConfig[key])) {
        (delta as Record<string, unknown>)[key] = next[key];
      }
    }
    globalConfig = normalizeToolDisplayConfig({ ...globalConfig, ...delta });
    mergedConfig = projectOverlay ? mergeProjectConfig(globalConfig, projectOverlay) : globalConfig;
    effectiveConfig = undefined;

    const saved = saveToolDisplayConfig(globalConfig);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }
  };

  // Always register session_start so project config can load even when
  // global enabled is false — the enabled check gates rendering, not config.
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
    mergedConfig = globalConfig;
    effectiveConfig = undefined;

    // Project-local config overlay: read-only, trusted projects only.
    // Loaded regardless of global enabled — project may override it.
    projectOverlay = undefined;
    if (ctx.isProjectTrusted()) {
      const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "pi-tool-display", "config.json");
      const projectResult = readProjectToolDisplayConfig(projectConfigPath);
      if (projectResult.config) {
        projectOverlay = projectResult.config;
        mergedConfig = mergeProjectConfig(globalConfig, projectOverlay);
        effectiveConfig = undefined;
      }
      if (projectResult.error) {
        ctx.ui.notify(projectResult.error, "warning");
      }
    }

    // If the effective config (after project overlay) is disabled, skip
    // registering rendering infrastructure.
    if (!mergedConfig.enabled) {
      return;
    }

    registerToolDisplayApi(getEffectiveConfig);
    registerToolExecutionPatch(pi, getEffectiveConfig);
    registerNativeUserMessageBox(pi, getConfig);
    registerToolDisplayCommand(pi, { getConfig, setConfig, getCapabilities });
  });

  pi.on("before_agent_start", async () => {
    if (!mergedConfig.enabled) return;
    refreshCapabilities();
  });
}
