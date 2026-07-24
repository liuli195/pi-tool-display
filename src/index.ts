import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  CONFIG_DIR_NAME,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  applyToolDisplayConfigPatch,
  loadToolDisplayConfig,
  readProjectToolDisplayConfig,
  mergeProjectConfig,
  saveToolDisplayConfig,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import { registerToolDisplayApi } from "./tool-overrides.js";
import { registerToolExecutionPatch } from "./tool-execution-patch.js";
import { disposeAll, registerCleanup, resetDisposed } from "./disposable.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import type { UserMessageTheme } from "./user-message-box-renderer.js";
import type { ToolDisplayConfig, ToolDisplayConfigOverlay } from "./types.js";
import {
  registerToolDisplayCommand,
  type ToolDisplayConfigMutation,
} from "./config-command.js";
import { getToolDisplayPresetConfig } from "./presets.js";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  resetDisposed();

  let globalConfig: ToolDisplayConfig = initial.config;
  let mergedConfig: ToolDisplayConfig = globalConfig;
  let pendingLoadError = initial.error;
  let capabilities: ToolDisplayCapabilities = { hasRtkOptimizer: false };
  let effectiveConfig: ToolDisplayConfig | undefined;
  let projectOverlay: ToolDisplayConfigOverlay | undefined;
  let activeTheme: UserMessageTheme | undefined;
  let disposeSessionInstallation: (() => void) | undefined;

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
    effectiveConfig = undefined;
  };
  const getConfig = (): ToolDisplayConfig => mergedConfig;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    effectiveConfig ??= applyCapabilityConfigGuards(mergedConfig, capabilities);

  const uninstallSession = (): void => {
    disposeSessionInstallation?.();
    disposeSessionInstallation = undefined;
  };

  const installSession = (): void => {
    uninstallSession();
    if (!mergedConfig.enabled) return;
    const disposers = [
      registerToolExecutionPatch(pi, getEffectiveConfig),
      registerNativeUserMessageBox(pi, getConfig, activeTheme),
    ];
    let disposed = false;
    disposeSessionInstallation = () => {
      if (disposed) return;
      disposed = true;
      for (let index = disposers.length - 1; index >= 0; index--) disposers[index]();
    };
  };

  const mutateConfig = (
    mutation: ToolDisplayConfigMutation,
    ctx: ExtensionCommandContext,
  ): void => {
    globalConfig = mutation.type === "patch"
      ? applyToolDisplayConfigPatch(globalConfig, mutation.patch)
      : getToolDisplayPresetConfig(mutation.type === "preset" ? mutation.preset : "opencode");
    mergedConfig = projectOverlay ? mergeProjectConfig(globalConfig, projectOverlay) : globalConfig;
    effectiveConfig = undefined;

    const saved = saveToolDisplayConfig(globalConfig);
    if (!saved.success && saved.error) ctx.ui.notify(saved.error, "error");
    installSession();
  };

  registerCleanup(uninstallSession);
  registerToolDisplayApi(getEffectiveConfig);
  registerToolDisplayCommand(pi, { getConfig, mutateConfig, getCapabilities });
  // Reload replaces the extension factory without a new session_start event.
  // Install from global config immediately; session_start replaces it with the
  // trusted project-effective installation when available.
  installSession();

  pi.on("session_shutdown", (event: { reason: string }) => {
    uninstallSession();
    activeTheme = undefined;
    if (event.reason === "reload" || event.reason === "quit") disposeAll();
  });

  pi.on("session_start", async (_event, ctx) => {
    uninstallSession();
    refreshCapabilities();
    activeTheme = ctx.ui?.theme as unknown as UserMessageTheme | undefined;
    if (pendingLoadError) {
      ctx.ui?.notify?.(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }

    const fresh = loadToolDisplayConfig();
    globalConfig = fresh.config;
    projectOverlay = undefined;
    if (ctx.isProjectTrusted()) {
      const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "pi-tool-display", "config.json");
      const projectResult = readProjectToolDisplayConfig(projectConfigPath);
      projectOverlay = projectResult.config;
      if (projectResult.error) ctx.ui?.notify?.(projectResult.error, "warning");
    }
    mergedConfig = projectOverlay ? mergeProjectConfig(globalConfig, projectOverlay) : globalConfig;
    effectiveConfig = undefined;
    installSession();
  });

  pi.on("before_agent_start", async () => {
    if (!mergedConfig.enabled) return;
    refreshCapabilities();
  });
}
