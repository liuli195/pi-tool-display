import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayConfig } from "./types.js";
import { toRecord } from "./tool-metadata.js";
import { formatGenericToolCallLine, formatMcpCallLine, formatSearchCallLine, getRuntimeBuiltInToolOverride, getRuntimeCustomToolOverride, getSearchScope, renderCustomToolResult, renderReadDisplayCall, renderReadDisplayResult, renderSearchResult, type RenderTheme } from "./tool-overrides.js";

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
      if (row.toolName === "read" && config.registerToolOverrides.read) return {
        ...native,
        call: (args: unknown, theme: RenderTheme) => renderReadDisplayCall(args, theme),
        result: (result: any, options: ToolRenderResultOptions, theme: RenderTheme) => renderReadDisplayResult(result, options, config as ToolDisplayConfig, theme),
      };
      if (["grep", "find", "ls"].includes(row.toolName) && config.registerToolOverrides[row.toolName as "grep" | "find" | "ls"]) {
        const labels = row.toolName === "grep" ? ["match", "matches"] : row.toolName === "ls" ? ["entry", "entries"] : ["result", undefined];
        const call: ToolRenderer = (args: Record<string, unknown>, theme: RenderTheme) => {
          const scope = getSearchScope(args);
          const limit = args.limit !== undefined ? ` (limit ${args.limit})` : "";
          if (row.toolName === "grep") return formatSearchCallLine("grep", `/${args.pattern}/`, ` in ${scope}${args.glob ? ` (${args.glob})` : ""}${args.limit !== undefined ? ` limit ${args.limit}` : ""}`, theme);
          return formatSearchCallLine(row.toolName, row.toolName === "find" ? String(args.pattern) : scope, row.toolName === "find" ? ` in ${scope}${limit}` : limit, theme);
        };
        const result: ToolRenderer = (value: any, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderSearchResult(value, options, config as ToolDisplayConfig, theme, labels[0]!, value?.details, labels[1]);
        return { ...native, call, result };
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
