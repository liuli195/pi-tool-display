import type {
  BashToolDetails,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { VisualLinePreviewComponent } from "./bash-display.js";
import { renderEditDiffResult } from "./diff-renderer.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import { registerCleanup } from "./disposable.js";
import { registerProducerRendererAdapter, type ProducerRendererAdapter } from "./renderer-catalog.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import {
  getTextField,
  toRecord,
} from "./tool-metadata.js";
import { BUILT_IN_TOOL_DISPLAY_NAMES } from "./types.js";
import { normalizeCustomToolOverrideEntry } from "./config-store.js";
import type {
  CustomToolOverrideConfig,
  ToolDisplayConfig,
} from "./types.js";

type ConfigGetter = () => ToolDisplayConfig;

interface RuntimeToolDefinition {
  name?: string;
  [key: string]: unknown;
}

export interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

const RTK_COMPACTION_LABEL = "compacted by RTK";
const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";

export interface ToolDisplayAdapter {
  id?: string;
  toolName?: string;
  kind?: ToolDisplayKind;
  overrideExistingRenderers?: boolean;
  pathFields?: string[];
  getPath?: (args: unknown) => string | undefined;
  getEditLineCount?: (args: unknown) => number;
  renderCall?: (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => unknown;
  renderResult?: (result: unknown, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
}

export interface ToolDisplayApi {
  version: 1;
  registerAdapter(adapter: ProducerRendererAdapter): () => void;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
}

interface PendingToolDisplayDecoration {
  toolName?: string;
  adapter?: ToolDisplayAdapter;
  disposed?: boolean;
  liveDispose?: () => void;
}

type GlobalWithToolDisplayApi = typeof globalThis & {
  [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
  [TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: PendingToolDisplayDecoration[];
};

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: RenderTheme): string {
  if (remaining <= 0) {
    return "";
  }
  const hint = expanded ? "" : " • Ctrl+O to expand";
  return `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) {
    return theme.fg("muted", "↳ (no output)");
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  text += formatTruncationHint(remaining, expanded, theme);
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "↳ command completed (no output)");
  }
  return theme.fg("muted", "↳ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getEditPayloadLineCount(value: unknown): number {
  const record = toRecord(value);
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.filter((line): line is string => typeof line === "string").length;
  }
  if (typeof lines === "string") {
    return countTextLines(lines);
  }

  return countTextLines(record.newText);
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits as unknown[] : [];
  if (edits.length > 0) {
    return edits.reduce<number>((total, edit) => {
      return total + getEditPayloadLineCount(edit);
    }, 0);
  }

  return getEditPayloadLineCount(record);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function getRtkCompactionInfoIfApplied(
  details: unknown,
  config: ToolDisplayConfig,
): RtkCompactionInfo | undefined {
  if (!config.showRtkCompactionHints) {
    return undefined;
  }
  const info = getRtkCompactionInfo(details);
  return info?.applied ? info : undefined;
}

function withRtkCompactionInfo(
  params: RtkHintParams,
  handler: (info: RtkCompactionInfo) => string,
): string {
  const info = getRtkCompactionInfoIfApplied(params.details, params.config);
  return info ? handler(info) : "";
}

interface RtkHintParams {
  details: unknown;
  config: ToolDisplayConfig;
  theme: RenderTheme;
}

interface PreviewHintContext {
  lines: string[];
  config: ToolDisplayConfig;
  theme: RenderTheme;
  options: ToolRenderResultOptions;
  details: unknown;
}

interface McpPreviewHintContext extends PreviewHintContext {
  truncation: { truncated: boolean; fullOutputPath?: string };
}

function handlePartialResult(
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  message: string,
): Text | undefined {
  return options.isPartial ? partialResultText(theme, message) : undefined;
}

function renderSearchPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendPreviewHints(p, ctx), expandedOnly);
}

function renderMcpPreview(ctx: McpPreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendMcpPreviewHints(p, ctx), expandedOnly);
}

function formatRtkSummarySuffix(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const segments: string[] = [RTK_COMPACTION_LABEL];

    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      segments.push(techniqueText);
    }
    if (info.truncated) {
      segments.push("RTK removed content");
    }

    if (segments.length === 0) {
      return "";
    }

    return theme.fg("warning", ` • ${segments.join(" • ")}`);
  });
}

function getExpandedPreviewLineLimit(
  lines: string[],
  config: ToolDisplayConfig,
): number {
  const limit = Math.max(0, config.expandedPreviewMaxLines);
  if (limit === 0) {
    return lines.length;
  }
  return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  const cap = Math.max(0, config.expandedPreviewMaxLines);
  if (cap === 0 || lines.length <= cap) {
    return "";
  }

  return `\n${theme.fg("warning", `(display capped at ${cap} lines by tool-display setting)`)}`;
}

function formatRtkPreviewHint(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const hints: string[] = [];
    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
    } else {
      hints.push(`${RTK_COMPACTION_LABEL} applied`);
    }

    if (
      info.originalLineCount !== undefined &&
      info.compactedLineCount !== undefined &&
      info.originalLineCount > info.compactedLineCount
    ) {
      hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
    }

    if (info.truncated) {
      hints.push("RTK removed content");
    }

    return hints.length > 0
      ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
      : "";
  });
}

function appendRtkAndExpandedHints(preview: string, ctx: PreviewHintContext): string {
  preview += formatRtkPreviewHint(ctx);
  if (ctx.options.expanded) {
    preview += formatExpandedPreviewCapHint(ctx.lines, ctx.config, ctx.theme);
  }
  return preview;
}

function appendMcpPreviewHints(preview: string, ctx: McpPreviewHintContext): string {
  const { config, theme, details, lines, options, truncation } = ctx;
  if (config.showTruncationHints && (truncation.truncated || truncation.fullOutputPath)) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, details } = ctx;
  if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function renderPreviewText(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  appendHints: (preview: string) => string,
  expandedOnly: boolean = false,
): Text {
  const useExpanded = expandedOnly || options.expanded;
  const maxLines = useExpanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  const preview = buildPreviewText(lines, maxLines, theme, useExpanded);
  return textResult(appendHints(preview));
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function getBashPreviewLineLimit(
  lines: string[],
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): number {
  if (options.expanded) {
    return getExpandedPreviewLineLimit(lines, config);
  }

  return config.bashOutputMode === "opencode"
    ? config.bashCollapsedLines
    : config.previewLines;
}

type ToolRenderInput = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function partialResultText(theme: RenderTheme, label: string): Text {
  return textResult(theme.fg("warning", label));
}

function renderBashPreviewWithHints(
  lines: string[],
  maxLines: number,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  details: BashToolDetails | undefined,
): Text {
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return textResult(preview);
}

function prepareBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): { lines: string[]; maxLines: number } | undefined {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return undefined;
  }
  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return undefined;
  }
  return { lines, maxLines };
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const prepared = prepareBashLivePreview(rawOutput, options, config);
  if (!prepared) {
    return textResult("");
  }
  return renderBashPreviewWithHints(prepared.lines, prepared.maxLines, config, theme, options, details);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Component {
  const lines = prepareOutputLines(rawOutput, options);
  const container = new Container();
  container.addChild(textResult(theme.fg("error", options.expanded || config.bashErrorOutputMode !== "summary"
    ? "↳ command failed"
    : `↳ command failed · ${lines.length} ${pluralize(lines.length, "line")} returned`)));

  if (lines.length > 0 && (options.expanded || config.bashErrorOutputMode !== "summary")) {
    const maxLines = options.expanded ? getExpandedPreviewLineLimit(lines, config) : lines.length;
    const { shown, remaining } = previewLines(lines, maxLines);
    let body = shown.map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line))).join("\n");
    body += formatTruncationHint(remaining, options.expanded, theme);
    if (config.showTruncationHints) body += formatBashTruncationHints(details, theme);
    if (options.expanded) body += formatExpandedPreviewCapHint(lines, config, theme);

    if (!options.expanded && config.bashErrorOutputMode === "preview") {
      const preview = new VisualLinePreviewComponent(config.bashErrorPreviewLines, false, theme);
      preview.setDisplay(body, config.bashErrorPreviewLines, false);
      container.addChild(preview);
    } else {
      container.addChild(textResult(body));
    }
  }

  return container;
}

export function renderBashResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  context?: { args?: unknown; isError?: boolean },
): Component {
  const details = result.details as BashToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  if (options.isPartial) return renderBashLivePreview(rawOutput, options, config, theme, details);
  if (isToolError(result, context)) return renderBashErrorResult(rawOutput, options, config, theme, details);

  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
    if (config.showTruncationHints) text += formatBashTruncationHints(details, theme);
    return textResult(text);
  }
  if (config.bashOutputMode === "summary") {
    if (options.expanded) return renderBashPreviewWithHints(lines, getExpandedPreviewLineLimit(lines, config), config, theme, options, details);
    let summary = formatBashSummary(lines, details, theme, config.showTruncationHints) + formatExpandHint(theme);
    if (config.showTruncationHints) summary += formatBashTruncationHints(details, theme);
    return textResult(summary);
  }
  if (config.bashOutputMode === "preview") {
    return renderBashPreviewWithHints(lines, options.expanded ? getExpandedPreviewLineLimit(lines, config) : config.previewLines, config, theme, options, details);
  }
  if (!options.expanded && config.bashCollapsedLines === 0) {
    let hidden = theme.fg("muted", "↳ output hidden");
    if (config.showTruncationHints) hidden += formatBashTruncationHints(details, theme);
    return textResult(hidden);
  }
  let text = buildPreviewText(lines, options.expanded ? lines.length : config.bashCollapsedLines, theme, options.expanded);
  if (config.showTruncationHints) text += formatBashTruncationHints(details, theme);
  return textResult(text);
}


export function renderSearchResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return partialResultText(theme, "running...");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return textResult("");
  }

  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatArgCountSuffix(argCount: number, theme: RenderTheme): string {
  return argCount === 0
    ? theme.fg("muted", " (no args)")
    : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
}

export function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): Text {
  const argCount = Object.keys(args).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(args)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;

  return new Text(
    `${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", target)}${argSuffix}`,
    0,
    0,
  );
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  const partial = handlePartialResult(options, theme, "running...");
  if (partial) {
    return partial;
  }

  if (config.mcpOutputMode === "hidden") {
    return textResult("");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);
  const truncation = getMcpTruncationDetails(result.details);
  const mcpCtx: McpPreviewHintContext = { lines, config, theme, options, details: result.details, truncation };

  if (config.mcpOutputMode === "summary") {
    if (options.expanded) {
      return renderMcpPreview(mcpCtx, true);
    }

    const lineCount = countNonEmptyLines(lines);
    let summary = theme.fg(
      "muted",
      `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderMcpPreview(mcpCtx);
}

function isBuiltInToolName(toolName: string): boolean {
  return (BUILT_IN_TOOL_DISPLAY_NAMES as readonly string[]).includes(toolName);
}

export function getRuntimeCustomToolOverride(
  toolName: string,
  config: ToolDisplayConfig,
): CustomToolOverrideConfig | undefined {
  if (!toolName || isBuiltInToolName(toolName)) {
    return undefined;
  }

  const overrides = toRecord((config as unknown as Record<string, unknown>).customToolOverrides);
  return normalizeCustomToolOverrideEntry(overrides[toolName]);
}

export function formatGenericToolCallLine(
  toolName: string,
  args: unknown,
  theme: RenderTheme,
): Text {
  const argRecord = toRecord(args);
  const argCount = Object.keys(argRecord).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))}${argSuffix}`,
    0,
    0,
  );
}

export function getSearchScope(args: Record<string, unknown>): string {
  return shortenPath((args.path as string) || ".");
}

export function formatSearchCallLine(
  toolName: string,
  accent: string,
  mutedSuffix: string,
  theme: RenderTheme,
): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", accent)}${theme.fg("muted", mutedSuffix)}`,
    0,
    0,
  );
}

export function renderCustomToolResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  outputMode: CustomToolOverrideConfig["outputMode"],
  theme: RenderTheme,
): Text {
  return renderMcpResult(
    result as ToolRenderInput,
    options,
    { ...config, mcpOutputMode: outputMode },
    theme,
  );
}

function getAdapterKind(tool: RuntimeToolDefinition, adapter: ToolDisplayAdapter): ToolDisplayKind {
  if (adapter.kind) return adapter.kind;
  return tool.name === "read" || tool.name === "edit" ? tool.name : "generic";
}

function getAdapterPath(args: unknown, adapter: ToolDisplayAdapter): string | undefined {
  const explicitPath = adapter.getPath?.(args);
  if (explicitPath) {
    return explicitPath;
  }

  for (const field of adapter.pathFields ?? ["file_path", "path"]) {
    const value = getStringField(args, field);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function renderReadDisplayCall(
  args: unknown,
  theme: RenderTheme,
  adapter: ToolDisplayAdapter = {},
 ): Text {
  const path = shortenPath(getAdapterPath(args, adapter));
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  let suffix = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    suffix = to ? `:${from}-${to}` : `:${from}`;
  }
  const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
  return textResult(line);
}

export function renderReadDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
 ): Text {
  if (options.isPartial) {
    return partialResultText(theme, "reading...");
  }

  if (config.readOutputMode === "hidden") {
    return textResult("");
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    const summaryLines = compactOutputLines(splitLines(rawOutput), {
      expanded: true,
    });
    let summary = formatReadSummary(
      summaryLines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function renderEditDisplayCall(
  args: unknown,
  theme: RenderTheme,
  adapter: ToolDisplayAdapter = {},
): Text {
  const path = shortenPath(getAdapterPath(args, adapter));
  const lineCount = adapter.getEditLineCount?.(args) ?? getEditLineCount(args);
  return textResult(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`);
}

function renderEditDisplayResult(
  result: ToolRenderInput & { isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter,
  getConfig: ConfigGetter,
): unknown {
  const lineCount = adapter.getEditLineCount?.(context?.args) ?? getEditLineCount(context?.args);
  if (options.isPartial) return textResult(formatInProgressLineCount("editing", lineCount, theme));
  const fallback = extractTextOutput(result);
  if (isToolError(result, context)) return textResult(theme.fg("error", fallback || "Edit failed."));
  return renderEditDiffResult(
    result.details,
    { expanded: options.expanded, filePath: getAdapterPath(context?.args, adapter) },
    getConfig(),
    theme,
    fallback,
  );
}

function toProducerAdapter(toolName: string, adapter: ToolDisplayAdapter = {}, getConfig: ConfigGetter): ProducerRendererAdapter {
  const kind = getAdapterKind({ name: toolName }, adapter);
  return {
    id: adapter.id ?? toolName,
    toolName,
    kind: kind === "mcp" ? "mcp" : "generic",
    overrideCallRenderer: adapter.overrideExistingRenderers,
    renderCall: adapter.renderCall ?? (kind === "read"
      ? (args, theme) => renderReadDisplayCall(args, theme, adapter)
      : kind === "edit"
        ? (args, theme) => renderEditDisplayCall(args, theme, adapter)
        : undefined),
    renderResult: adapter.renderResult ?? (kind === "read"
      ? (result, options, theme) => renderReadDisplayResult(result, options, getConfig(), theme)
      : kind === "edit"
        ? (result, options, theme, context) => renderEditDisplayResult(result, options, theme, context, adapter, getConfig)
        : undefined),
  };
}

function drainPendingToolDisplayDecorations(api: ToolDisplayApi, getConfig: ConfigGetter): void {
  const globalWithApi = globalThis as GlobalWithToolDisplayApi;
  const entries = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  delete globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry?.disposed) continue;
    const toolName = entry?.toolName;
    if (!toolName) continue;
    try {
      entry.liveDispose = api.registerAdapter(toProducerAdapter(toolName, entry.adapter, getConfig));
      if (entry.disposed) entry.liveDispose();
    } catch (error) { logToolDisplayDebug("Tool display Adapter registration failed.", error); }
  }
  entries.length = 0;
}

function installToolDisplayApi(_getConfig: ConfigGetter): ToolDisplayApi {
  const disposers = new Set<() => void>();
  const legacyDisposers = new Map<string, () => void>();
  const api: ToolDisplayApi = {
    version: 1,
    registerAdapter(adapter) {
      const disposeRegistration = registerProducerRendererAdapter(adapter);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        disposers.delete(dispose);
        disposeRegistration();
      };
      disposers.add(dispose);
      return dispose;
    },
    decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T {
      const toolName = getTextField(tool, "name");
      if (!toolName) throw new Error("Tool display compatibility registration requires tool.name");
      const key = `${toolName}:${adapter?.id ?? toolName}`;
      legacyDisposers.get(key)?.();
      const dispose = api.registerAdapter(toProducerAdapter(toolName, adapter, _getConfig));
      legacyDisposers.set(key, dispose);
      return tool;
    },
  };
  (globalThis as GlobalWithToolDisplayApi)[TOOL_DISPLAY_API_KEY] = api;
  drainPendingToolDisplayDecorations(api, _getConfig);
  registerCleanup(() => { for (const dispose of [...disposers]) dispose(); });
  return api;
}

export function registerToolDisplayApi(getConfig: ConfigGetter): void {
  const toolDisplayApi = installToolDisplayApi(getConfig);
  registerCleanup(() => {
    const globalWithApi = globalThis as GlobalWithToolDisplayApi;
    if (globalWithApi[TOOL_DISPLAY_API_KEY] === toolDisplayApi) delete globalWithApi[TOOL_DISPLAY_API_KEY];
  });
}
