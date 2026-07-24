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
import { invalidateToolExecutionRows, registerToolExecutionPatch } from "./tool-execution-patch.js";
import { disposeAll, registerCleanup, resetDisposed } from "./disposable.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import type { UserMessageTheme } from "./user-message-box-renderer.js";
import type { ToolDisplayConfig, ToolDisplayConfigOverlay } from "./types.js";
import {
  registerToolDisplayCommand,
  type ToolDisplayConfigMutation,
} from "./config-command.js";
import { getToolDisplayPresetConfig } from "./presets.js";

const RELOAD_STATE = Symbol.for("pi-tool-display.reload-state.v1");
interface ReloadState {
  projectConfigPath?: string;
  theme?: UserMessageTheme;
  lastShutdownReason?: string;
}
type GlobalWithReloadState = typeof globalThis & { [RELOAD_STATE]?: ReloadState };

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  const globalWithReloadState = globalThis as GlobalWithReloadState;
  const reloadState = globalWithReloadState[RELOAD_STATE];
  const ordinarySessionTransition = ["new", "resume", "fork"].includes(reloadState?.lastShutdownReason ?? "");
  if (!ordinarySessionTransition) resetDisposed();
  const reloadedProject = reloadState?.projectConfigPath
    ? readProjectToolDisplayConfig(reloadState.projectConfigPath)
    : undefined;
  let globalConfig: ToolDisplayConfig = initial.config;
  let projectOverlay: ToolDisplayConfigOverlay | undefined = reloadedProject?.config;
  let mergedConfig: ToolDisplayConfig = projectOverlay
    ? mergeProjectConfig(globalConfig, projectOverlay)
    : globalConfig;
  let pendingLoadError = initial.error ?? reloadedProject?.error;
  let capabilities: ToolDisplayCapabilities = { hasRtkOptimizer: false };
  let effectiveConfig: ToolDisplayConfig | undefined;
  let activeTheme: UserMessageTheme | undefined = reloadState?.theme;
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
    invalidateToolExecutionRows();
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
    if (!mergedConfig.enabled) uninstallSession();
    else if (!disposeSessionInstallation) installSession();
    else invalidateToolExecutionRows();
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
    if (event.reason === "reload") {
      globalWithReloadState[RELOAD_STATE] = {
        ...globalWithReloadState[RELOAD_STATE],
        lastShutdownReason: event.reason,
      };
    } else {
      activeTheme = undefined;
      globalWithReloadState[RELOAD_STATE] = { lastShutdownReason: event.reason };
    }
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
    let projectConfigPath: string | undefined;
    if (ctx.isProjectTrusted()) {
      projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "pi-tool-display", "config.json");
      const projectResult = readProjectToolDisplayConfig(projectConfigPath);
      projectOverlay = projectResult.config;
      if (projectResult.error) ctx.ui?.notify?.(projectResult.error, "warning");
    }
    globalWithReloadState[RELOAD_STATE] = { projectConfigPath, theme: activeTheme };
    mergedConfig = projectOverlay ? mergeProjectConfig(globalConfig, projectOverlay) : globalConfig;
    effectiveConfig = undefined;
    installSession();
  });

  pi.on("before_agent_start", async () => {
    if (!mergedConfig.enabled) return;
    refreshCapabilities();
  });
}
