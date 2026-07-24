export const READ_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const SEARCH_OUTPUT_MODES = ["hidden", "count", "preview"] as const;
export const MCP_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const CUSTOM_TOOL_OVERRIDE_KINDS = ["generic", "mcp"] as const;
export const CUSTOM_TOOL_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const BASH_OUTPUT_MODES = ["opencode", "summary", "preview"] as const;
export const BASH_COMMAND_MODES = ["full", "summary", "preview"] as const;
export const BASH_ERROR_OUTPUT_MODES = ["full", "summary", "preview"] as const;
export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export const DIFF_INDICATOR_MODES = ["bars", "classic", "none"] as const;

export type ReadOutputMode = (typeof READ_OUTPUT_MODES)[number];
export type SearchOutputMode = (typeof SEARCH_OUTPUT_MODES)[number];
export type McpOutputMode = (typeof MCP_OUTPUT_MODES)[number];
export type CustomToolOverrideKind = (typeof CUSTOM_TOOL_OVERRIDE_KINDS)[number];
export type CustomToolOutputMode = (typeof CUSTOM_TOOL_OUTPUT_MODES)[number];
export type BashOutputMode = (typeof BASH_OUTPUT_MODES)[number];
export type BashCommandMode = (typeof BASH_COMMAND_MODES)[number];
export type BashErrorOutputMode = (typeof BASH_ERROR_OUTPUT_MODES)[number];
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];
export type DiffIndicatorMode = (typeof DIFF_INDICATOR_MODES)[number];

export const BUILT_IN_TOOL_DISPLAY_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;

export type BuiltInToolDisplayName = (typeof BUILT_IN_TOOL_DISPLAY_NAMES)[number];

export interface BuiltInToolDisplays {
	read: boolean;
	grep: boolean;
	find: boolean;
	ls: boolean;
	bash: boolean;
	edit: boolean;
	write: boolean;
}

export interface CustomToolOverrideConfig {
	enabled: boolean;
	kind: CustomToolOverrideKind;
	outputMode: CustomToolOutputMode;
	overrideCallRenderer: boolean;
}

export interface ToolDisplayConfig {
	enabled: boolean;
	builtInToolDisplays: BuiltInToolDisplays;
	customToolOverrides: Record<string, CustomToolOverrideConfig>;
	enableNativeUserMessageBox: boolean;
	readOutputMode: ReadOutputMode;
	searchOutputMode: SearchOutputMode;
	mcpOutputMode: McpOutputMode;
	previewLines: number;
	expandedPreviewMaxLines: number;
	bashOutputMode: BashOutputMode;
	bashCollapsedLines: number;
	bashCommandMode: BashCommandMode;
	bashCommandPreviewLines: number;
	bashErrorOutputMode: BashErrorOutputMode;
	bashErrorPreviewLines: number;
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	showTruncationHints: boolean;
	showRtkCompactionHints: boolean;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	enabled: true,
	builtInToolDisplays: {
		read: true,
		grep: true,
		find: true,
		ls: true,
		bash: true,
		edit: true,
		write: true,
	},
	customToolOverrides: {},
	enableNativeUserMessageBox: true,
	readOutputMode: "hidden",
	searchOutputMode: "hidden",
	mcpOutputMode: "hidden",
	previewLines: 8,
	expandedPreviewMaxLines: 4000,
	bashOutputMode: "opencode",
	bashCollapsedLines: 10,
	bashCommandMode: "preview",
	bashCommandPreviewLines: 3,
	bashErrorOutputMode: "preview",
	bashErrorPreviewLines: 3,
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	diffCollapsedLines: 24,
	diffWordWrap: true,
	showTruncationHints: false,
	showRtkCompactionHints: false,
};

export interface ConfigLoadResult {
	config: ToolDisplayConfig;
	error?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}
