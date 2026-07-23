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
export interface ProducerRendererAdapter {
  readonly id: string;
  readonly toolName: string;
  readonly kind: "generic" | "mcp";
  readonly outputMode?: "hidden" | "summary" | "preview";
  readonly overrideCallRenderer?: boolean;
  readonly renderCall?: ToolRenderer;
  readonly renderResult?: ToolRenderer;
}
export interface RendererCatalog {
  resolve(row: ToolRowDescriptor, config: Readonly<ToolDisplayConfig>, native: NativeRendererSlots): DisplayPlan | undefined;
}

const producerAdapters = new Map<string, Set<ProducerRendererAdapter>>();

export function registerProducerRendererAdapter(adapter: ProducerRendererAdapter): () => void {
  const adapters = producerAdapters.get(adapter.toolName) ?? new Set<ProducerRendererAdapter>();
  adapters.add(adapter);
  producerAdapters.set(adapter.toolName, adapters);
  return () => {
    adapters.delete(adapter);
    if (!adapters.size) producerAdapters.delete(adapter.toolName);
  };
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
      const configured = getRuntimeCustomToolOverride(row.toolName, config as ToolDisplayConfig);
      const producers = producerAdapters.get(row.toolName);
      if (!configured?.enabled && producers && producers.size > 1) throw new Error(`Renderer Adapter conflict for ${row.toolName}`);
      const custom = configured?.enabled ? configured : producers?.values().next().value;
      if (!custom) return undefined;
      const replacementCall = custom.renderCall ?? ((args: unknown, theme: RenderTheme) => custom.kind === "mcp"
        ? formatMcpCallLine(row.toolName, row.label ?? `MCP ${row.toolName}`, toRecord(args), theme)
        : formatGenericToolCallLine(row.toolName, args, theme));
      const call = native.call && !custom.overrideCallRenderer ? native.call : replacementCall;
      const outputMode = custom.outputMode ?? config.mcpOutputMode;
      return { ...native, call, result: custom.renderResult ?? ((result: any, options: ToolRenderResultOptions, theme: RenderTheme) =>
        renderCustomToolResult(result, options, config as ToolDisplayConfig, outputMode, theme)) };
    },
  };
}
