import { cloneCustomToolOverrides } from "./config-store.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type CustomToolOverrideConfig, type ToolDisplayConfig } from "./types.js";

export const TOOL_DISPLAY_PRESETS = ["opencode", "balanced", "verbose"] as const;
export type ToolDisplayPreset = (typeof TOOL_DISPLAY_PRESETS)[number];

const TOOL_DISPLAY_PRESET_CONFIGS: Record<ToolDisplayPreset, ToolDisplayConfig> = {
	opencode: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays },
	},
	balanced: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays },
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		bashOutputMode: "summary",
		bashCommandMode: "summary",
		bashErrorOutputMode: "summary",
	},
	verbose: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		builtInToolDisplays: { ...DEFAULT_TOOL_DISPLAY_CONFIG.builtInToolDisplays },
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		bashOutputMode: "preview",
		previewLines: 12,
		bashCollapsedLines: 20,
		bashCommandMode: "full",
		bashErrorOutputMode: "full",
	},
};

function builtInToolDisplaysEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return (
		a.builtInToolDisplays.read === b.builtInToolDisplays.read &&
		a.builtInToolDisplays.grep === b.builtInToolDisplays.grep &&
		a.builtInToolDisplays.find === b.builtInToolDisplays.find &&
		a.builtInToolDisplays.ls === b.builtInToolDisplays.ls &&
		a.builtInToolDisplays.bash === b.builtInToolDisplays.bash &&
		a.builtInToolDisplays.edit === b.builtInToolDisplays.edit &&
		a.builtInToolDisplays.write === b.builtInToolDisplays.write
	);
}

function customToolOverridesEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	const aEntries = Object.entries(a.customToolOverrides).sort(([left], [right]) => left.localeCompare(right));
	const bEntries = Object.entries(b.customToolOverrides).sort(([left], [right]) => left.localeCompare(right));
	if (aEntries.length !== bEntries.length) {
		return false;
	}

	return aEntries.every(([toolName, override], index) => {
		const [otherToolName, otherOverride] = bEntries[index];
		return (
			toolName === otherToolName &&
			override.enabled === otherOverride.enabled &&
			override.kind === otherOverride.kind &&
			override.outputMode === otherOverride.outputMode
		);
	});
}

function configsEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return (
		a.enabled === b.enabled &&
		a.debug === b.debug &&
		builtInToolDisplaysEqual(a, b) &&
		customToolOverridesEqual(a, b) &&
		a.enableNativeUserMessageBox === b.enableNativeUserMessageBox &&
		a.readOutputMode === b.readOutputMode &&
		a.searchOutputMode === b.searchOutputMode &&
		a.mcpOutputMode === b.mcpOutputMode &&
		a.previewLines === b.previewLines &&
		a.expandedPreviewMaxLines === b.expandedPreviewMaxLines &&
		a.bashOutputMode === b.bashOutputMode &&
		a.bashCollapsedLines === b.bashCollapsedLines &&
		a.bashCommandMode === b.bashCommandMode &&
		a.bashCommandPreviewLines === b.bashCommandPreviewLines &&
		a.bashErrorOutputMode === b.bashErrorOutputMode &&
		a.bashErrorPreviewLines === b.bashErrorPreviewLines &&
		a.diffViewMode === b.diffViewMode &&
		a.diffIndicatorMode === b.diffIndicatorMode &&
		a.diffSplitMinWidth === b.diffSplitMinWidth &&
		a.diffCollapsedLines === b.diffCollapsedLines &&
		a.diffWordWrap === b.diffWordWrap &&
		a.showTruncationHints === b.showTruncationHints &&
		a.showRtkCompactionHints === b.showRtkCompactionHints
	);
}

export function getToolDisplayPresetConfig(preset: ToolDisplayPreset): ToolDisplayConfig {
	const config = TOOL_DISPLAY_PRESET_CONFIGS[preset];
	return {
		...config,
		builtInToolDisplays: { ...config.builtInToolDisplays },
		customToolOverrides: cloneCustomToolOverrides(config.customToolOverrides),
	};
}

export function detectToolDisplayPreset(config: ToolDisplayConfig): ToolDisplayPreset | "custom" {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		if (configsEqual(config, TOOL_DISPLAY_PRESET_CONFIGS[preset])) {
			return preset;
		}
	}
	return "custom";
}

export function parseToolDisplayPreset(raw: string): ToolDisplayPreset | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	return TOOL_DISPLAY_PRESETS.find((preset) => preset === normalized);
}
