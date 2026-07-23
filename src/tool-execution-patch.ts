import {
  ToolExecutionComponent,
  type ExtensionAPI,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { toRecord } from "./tool-metadata.js";
import {
  formatGenericToolCallLine,
  formatMcpCallLine,
  getRuntimeBuiltInToolOverride,
  getRuntimeCustomToolOverride,
  isRuntimeBuiltInToolOverride,
  renderCustomToolResult,
  type RenderTheme,
} from "./tool-overrides.js";
import type { ToolDisplayConfig } from "./types.js";

type Renderer = (...args: any[]) => unknown;
type Resolver = (this: ToolExecutionLike) => Renderer | undefined;

interface ToolExecutionLike {
  toolName?: string;
  toolDefinition?: Record<string, unknown>;
  builtInToolDefinition?: Record<string, unknown>;
}

interface PatchState {
  owner: object;
  originalCall: Resolver;
  originalResult: Resolver;
  patchedCall: Resolver;
  patchedResult: Resolver;
}

const PATCH_STATE = Symbol.for("pi-tool-display.toolExecutionPatch.v1");
const PATCH_OWNER = {};
type PatchablePrototype = ToolExecutionLike & {
  getCallRenderer: Resolver;
  getResultRenderer: Resolver;
  [PATCH_STATE]?: PatchState;
};

export function registerToolExecutionPatch(
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
): void {
  const prototype = ToolExecutionComponent.prototype as unknown as PatchablePrototype;
  const existing = prototype[PATCH_STATE];
  if (existing?.owner === PATCH_OWNER && prototype.getCallRenderer === existing.patchedCall && prototype.getResultRenderer === existing.patchedResult) {
    return;
  }

  if (existing) {
    if (prototype.getCallRenderer === existing.patchedCall) prototype.getCallRenderer = existing.originalCall;
    if (prototype.getResultRenderer === existing.patchedResult) prototype.getResultRenderer = existing.originalResult;
    delete prototype[PATCH_STATE];
  }

  const originalCall = prototype.getCallRenderer;
  const originalResult = prototype.getResultRenderer;

  const getOverride = (instance: ToolExecutionLike) => {
    const name = instance.toolDefinition?.name;
    if (typeof name !== "string") return undefined;
    if (instance.builtInToolDefinition) return undefined;
    const override = getRuntimeCustomToolOverride(name, getConfig());
    return override?.enabled ? { name, override } : undefined;
  };

  const getBuiltInRenderer = (instance: ToolExecutionLike, field: "renderCall" | "renderResult") => {
    const name = instance.toolDefinition?.name ?? instance.builtInToolDefinition?.name ?? instance.toolName;
    if (
      typeof name !== "string" ||
      instance.builtInToolDefinition?.name !== name ||
      (instance.toolDefinition !== undefined && !isRuntimeBuiltInToolOverride(instance.toolDefinition))
    ) return undefined;
    const renderer = getRuntimeBuiltInToolOverride(pi, name)?.[field];
    return typeof renderer === "function" ? renderer as Renderer : undefined;
  };

  const patchedCall: Resolver = function () {
    const currentBuiltIn = getBuiltInRenderer(this, "renderCall");
    if (currentBuiltIn) return currentBuiltIn;
    const matched = getOverride(this);
    if (!matched) return originalCall.call(this);

    const nativeRenderer = originalCall.call(this);
    if (nativeRenderer && !matched.override.overrideCallRenderer) return nativeRenderer;

    return (args: unknown, theme: RenderTheme) => matched.override.kind === "mcp"
      ? formatMcpCallLine(
          matched.name,
          typeof this.toolDefinition?.label === "string" ? this.toolDefinition.label : `MCP ${matched.name}`,
          toRecord(args),
          theme,
        )
      : formatGenericToolCallLine(matched.name, args, theme);
  };

  const patchedResult: Resolver = function () {
    const currentBuiltIn = getBuiltInRenderer(this, "renderResult");
    if (currentBuiltIn) return currentBuiltIn;
    const matched = getOverride(this);
    if (!matched) return originalResult.call(this);

    return (result: unknown, options: ToolRenderResultOptions, theme: RenderTheme) =>
      renderCustomToolResult(result as never, options, getConfig(), matched.override.outputMode, theme);
  };

  const state = { owner: PATCH_OWNER, originalCall, originalResult, patchedCall, patchedResult };
  prototype.getCallRenderer = patchedCall;
  prototype.getResultRenderer = patchedResult;
  prototype[PATCH_STATE] = state;

  onReloadShutdown(pi, () => {
    if (prototype.getCallRenderer === patchedCall) prototype.getCallRenderer = originalCall;
    if (prototype.getResultRenderer === patchedResult) prototype.getResultRenderer = originalResult;
    if (prototype[PATCH_STATE] === state) delete prototype[PATCH_STATE];
  });
}
