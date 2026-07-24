import type { ExtensionAPI, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "./diff-renderer.js";
import { extractTextOutput, shortenPath } from "./render-utils.js";
import type { ToolDisplayConfig } from "./types.js";
import { renderBashCall } from "./bash-display.js";
import { toRecord } from "./tool-metadata.js";
import { countWriteContentLines, getWriteContentSizeBytes } from "./write-display-utils.js";
import { formatGenericToolCallLine, formatMcpCallLine, formatSearchCallLine, getRuntimeCustomToolOverride, getSearchScope, renderBashResult, renderCustomToolResult, renderReadDisplayCall, renderReadDisplayResult, renderSearchResult, type RenderTheme } from "./tool-overrides.js";

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
export class RendererAdapterConflict extends Error {
  constructor(readonly toolName: string, readonly adapters: readonly { id: string; kind: ProducerRendererAdapter["kind"] }[]) {
    super(`Renderer Adapter conflict for ${toolName}: ${adapters.map(({ id, kind }) => `${id} (${kind})`).join(", ")}`);
  }
}

const producerAdapters = new Map<string, Map<string, ProducerRendererAdapter>>();

export function registerProducerRendererAdapter(adapter: ProducerRendererAdapter): () => void {
  const registered = Object.freeze({ ...adapter });
  const adapters = producerAdapters.get(registered.toolName) ?? new Map<string, ProducerRendererAdapter>();
  if (adapters.has(registered.id)) throw new Error(`Renderer Adapter '${registered.id}' is already registered for ${registered.toolName}`);
  adapters.set(registered.id, registered);
  producerAdapters.set(registered.toolName, adapters);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (adapters.get(registered.id) === registered) adapters.delete(registered.id);
    if (!adapters.size) producerAdapters.delete(registered.toolName);
  };
}

function changedPatch(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(/\r?\n/).some((line) => /^[-+](?!---|\+\+\+)/.test(line)) ? value : undefined;
}

function suppliedDiff(value: unknown, seen = new Set<object>()): string | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  try {
    const record = toRecord(value);
    for (const key of ["diff", "patch"] as const) {
      if (record[key] !== undefined) return changedPatch(record[key]);
    }
    for (const key of ["patches", "edits"] as const) {
      if (record[key] === undefined) continue;
      if (!Array.isArray(record[key]) || record[key].length === 0) return undefined;
      const patches = record[key].map((item) => suppliedDiff(item, seen));
      return patches.every((patch): patch is string => !!patch) ? patches.join("\n") : undefined;
    }
    return undefined;
  } finally { seen.delete(value); }
}

const lineNumber = (value: unknown, fallback: number) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
function replacementDiff(value: unknown): string | undefined {
  const record = toRecord(value);
  const replacements = Array.isArray(record.edits) ? record.edits.map(toRecord) : [record];
  if (!replacements.length || replacements.some((edit) => typeof edit.oldText !== "string" || typeof edit.newText !== "string")) return undefined;
  return replacements.map((edit) => {
    const oldStart = lineNumber(edit.oldStart ?? edit.startLine, lineNumber(record.oldStart ?? record.startLine, 1));
    const newStart = lineNumber(edit.newStart, lineNumber(record.newStart, oldStart));
    const oldLines = (edit.oldText as string).replace(/\r/g, "").split("\n");
    const newLines = (edit.newText as string).replace(/\r/g, "").split("\n");
    return `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@\n${oldLines.map((line) => `-${line}`).join("\n")}\n${newLines.map((line) => `+${line}`).join("\n")}`;
  }).join("\n");
}

function editEvidence(result: unknown, args: Readonly<Record<string, unknown>>): string | undefined {
  const resultRecord = toRecord(result);
  return suppliedDiff(resultRecord.details) ?? suppliedDiff(resultRecord) ?? suppliedDiff(args) ?? replacementDiff(args);
}

function explicitDiffEvidence(result: unknown, args: Readonly<Record<string, unknown>>): string | undefined {
  const resultRecord = toRecord(result);
  return suppliedDiff(resultRecord.details) ?? suppliedDiff(resultRecord) ?? suppliedDiff(args);
}

function writeRenderers(row: ToolRowDescriptor, config: Readonly<ToolDisplayConfig>, native: NativeRendererSlots): DisplayPlan {
  const path = typeof row.arguments.path === "string" ? row.arguments.path : typeof row.arguments.file_path === "string" ? row.arguments.file_path : "...";
  const renderCall: ToolRenderer = (args: unknown, theme: RenderTheme) => {
    const content = toRecord(args).content;
    const lines = countWriteContentLines(content);
    const bytes = getWriteContentSizeBytes(content);
    const metrics = typeof content === "string" ? ` (${lines} ${lines === 1 ? "line" : "lines"}, ${bytes} ${bytes === 1 ? "byte" : "bytes"})` : "";
    return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", shortenPath(path))}${theme.fg("muted", metrics)}`, 0, 0);
  };
  const renderResult: ToolRenderer = (result: any, options: ToolRenderResultOptions, theme: RenderTheme, context?: { isError?: boolean }) => {
    const fallback = extractTextOutput(result);
    if (options.isPartial) return new Text(theme.fg("muted", "↳ writing..."), 0, 0);
    if (result?.isError || context?.isError) return new Text(theme.fg("error", fallback || "Write failed."), 0, 0);
    const diff = explicitDiffEvidence(result, row.arguments);
    return diff
      ? renderEditDiffResult({ diff }, { expanded: options.expanded, filePath: path }, config as ToolDisplayConfig, theme, fallback)
      : new Text(fallback || theme.fg("muted", "Write completed."), 0, 0);
  };
  const failOpen = (renderer: ToolRenderer, fallback?: ToolRenderer): ToolRenderer => (...args: any[]) => {
    try { return renderer(...args); } catch { return fallback?.(...args); }
  };
  return { call: failOpen(renderCall, native.call), result: failOpen(renderResult, native.result), shell: "default" };
}

function editRenderers(row: ToolRowDescriptor, config: Readonly<ToolDisplayConfig>, native: NativeRendererSlots): DisplayPlan {
  const path = typeof row.arguments.path === "string" ? row.arguments.path : typeof row.arguments.file_path === "string" ? row.arguments.file_path : "...";
  const renderCall: ToolRenderer = (args: unknown, theme: RenderTheme, context?: { isPartial?: boolean; argsComplete?: boolean }) => {
    const title = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(path))}`;
    const diff = context?.isPartial && context.argsComplete ? replacementDiff(args) ?? suppliedDiff(args) : undefined;
    if (!diff) return new Text(title, 0, 0);
    const container = new Container();
    container.addChild(new Text(title, 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(renderEditDiffResult({ diff }, { expanded: true, filePath: path }, config as ToolDisplayConfig, theme, ""));
    return container;
  };
  const renderResult: ToolRenderer = (result: any, options: ToolRenderResultOptions, theme: RenderTheme, context?: { isError?: boolean }) => {
    const fallback = extractTextOutput(result);
    if (options.isPartial) return new Text(theme.fg("muted", "↳ editing..."), 0, 0);
    if (result?.isError || context?.isError) return new Text(theme.fg("error", fallback || "Edit failed."), 0, 0);
    const diff = editEvidence(result, row.arguments);
    return renderEditDiffResult(diff ? { diff } : undefined, { expanded: options.expanded, filePath: path }, config as ToolDisplayConfig, theme, fallback);
  };
  const failOpen = (renderer: ToolRenderer, fallback?: ToolRenderer): ToolRenderer => (...args: any[]) => {
    try { return renderer(...args); } catch { return fallback?.(...args); }
  };
  return { call: failOpen(renderCall, native.call), result: failOpen(renderResult, native.result), shell: "default" };
}

export function createRendererCatalog(_pi?: ExtensionAPI): RendererCatalog {
  return {
    resolve(row, config, native) {
      if (row.toolName === "read" && config.builtInToolDisplays.read) return {
        ...native,
        call: (args: unknown, theme: RenderTheme) => renderReadDisplayCall(args, theme),
        result: (result: any, options: ToolRenderResultOptions, theme: RenderTheme) => renderReadDisplayResult(result, options, config as ToolDisplayConfig, theme),
      };
      if (["grep", "find", "ls"].includes(row.toolName) && config.builtInToolDisplays[row.toolName as "grep" | "find" | "ls"]) {
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
      if (row.toolName === "edit" && config.builtInToolDisplays.edit) return { ...native, ...editRenderers(row, config, native) };
      if (row.toolName === "write" && config.builtInToolDisplays.write) return { ...native, ...writeRenderers(row, config, native) };
      if (row.toolName === "bash" && config.builtInToolDisplays.bash) return {
        ...native,
        call: (args: unknown, theme: RenderTheme, context: unknown) => renderBashCall(args as never, theme, context as never, config as ToolDisplayConfig),
        result: (result: any, options: ToolRenderResultOptions, theme: RenderTheme, context: any) =>
          renderBashResult(result, options, config as ToolDisplayConfig, theme, context),
      };
      if (row.builtIn) return undefined;
      const configured = getRuntimeCustomToolOverride(row.toolName, config as ToolDisplayConfig);
      const producers = producerAdapters.get(row.toolName);
      if (!configured?.enabled && producers && producers.size > 1) throw new RendererAdapterConflict(
        row.toolName,
        [...producers.values()].map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind)),
      );
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
