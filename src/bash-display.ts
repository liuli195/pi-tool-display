import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";

interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	shellPath?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	expanded?: boolean;
	lastComponent?: unknown;
}

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
}

function buildCommandDisplay(args: BashCallArgs): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? args.command
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

export class VisualLinePreviewComponent implements Component {
	private text = new Text("", 0, 0);

	constructor(
		private previewLines: number,
		private expanded: boolean,
		private theme: BashCallRenderTheme,
		private expandedBypass: boolean = false,
	) {}

	setDisplay(text: string, previewLines: number, expanded: boolean): void {
		this.text.setText(text);
		this.previewLines = previewLines;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		const lines = this.text.render(width);
		if (this.expanded && this.expandedBypass) return lines;
		if (lines.length <= this.previewLines) return lines;

		const hint = this.expanded
			? this.theme.fg("muted", `... (${lines.length - this.previewLines} more visual rows • display capped)`)
			: this.theme.fg("muted", `... (${lines.length - this.previewLines} more visual lines • Ctrl+O to expand)`);
		return [...lines.slice(0, this.previewLines), truncateToWidth(hint, width)];
	}

	invalidate(): void {
		this.text.invalidate();
	}
}

class BashCallComponent extends VisualLinePreviewComponent {}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
): string {
	const commandDisplay = buildCommandDisplay(args);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";

	return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${shellSuffix}${timeoutSuffix}`;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	config: Pick<ToolDisplayConfig, "bashCommandMode" | "bashCommandPreviewLines"> = DEFAULT_TOOL_DISPLAY_CONFIG,
): Component {
	const previewLines = config.bashCommandMode === "summary" ? 1 : config.bashCommandPreviewLines;
	const expanded = context.expanded === true || config.bashCommandMode === "full";
	const text = context.lastComponent instanceof BashCallComponent
		? context.lastComponent
		: new BashCallComponent(previewLines, expanded, theme, true);
	text.setDisplay(buildBashCallText(args, theme), previewLines, expanded);
	return text;
}
