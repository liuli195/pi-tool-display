import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayConfig } from "./types.js";
import { toRecord } from "./tool-metadata.js";
import { formatGenericToolCallLine, formatMcpCallLine, getRuntimeBuiltInToolOverride, getRuntimeCustomToolOverride, renderCustomToolResult, renderSearchResult, type RenderTheme } from "./tool-overrides.js";

export type ToolRenderer = (...args: any[]) => any;
export interface ToolRowDescriptor {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly label?: string;
  readonly builtIn?: boolean;
}
export interface NativeRendererSlots { readonly call?: ToolRenderer; readonly result?: ToolRenderer; readonly shell?: unknown }
export interface DisplayPlan extends NativeRendererSlots {}
export interface RendererCatalog {
  resolve(row: ToolRowDescriptor, config: Readonly<ToolDisplayConfig>, native: NativeRendererSlots): DisplayPlan | undefined;
}

export function createRendererCatalog(pi?: ExtensionAPI): RendererCatalog {
  return {
    resolve(row, config, native) {
      if (row.toolName === "grep" && config.registerToolOverrides.grep) {
        const renderResult: ToolRenderer = (result: any, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderSearchResult(result, options, config as ToolDisplayConfig, theme, "match", result?.details, "matches");
        return { ...native, result: renderResult };
      }
      if (row.builtIn && pi) {
        const definition = getRuntimeBuiltInToolOverride(pi, row.toolName);
        if (definition) return {
          ...native,
          ...(typeof definition.renderCall === "function" ? { call: definition.renderCall as ToolRenderer } : {}),
          ...(typeof definition.renderResult === "function" ? { result: definition.renderResult as ToolRenderer } : {}),
        };
      }
      if (row.builtIn) return undefined;
      const custom = getRuntimeCustomToolOverride(row.toolName, config as ToolDisplayConfig);
      if (!custom?.enabled) return undefined;
      const call = native.call && !custom.overrideCallRenderer ? native.call : (args: unknown, theme: RenderTheme) => custom.kind === "mcp"
        ? formatMcpCallLine(row.toolName, row.label ?? `MCP ${row.toolName}`, toRecord(args), theme)
        : formatGenericToolCallLine(row.toolName, args, theme);
      return { ...native, call, result: (result: any, options: ToolRenderResultOptions, theme: RenderTheme) =>
        renderCustomToolResult(result, options, config as ToolDisplayConfig, custom.outputMode, theme) };
    },
  };
}
