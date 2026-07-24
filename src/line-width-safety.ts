import { normalizeDiffRenderWidth } from "./diff-presentation.js";
import { pluralize } from "./render-utils.js";

export interface WidthMeasurementOps {
	measure(text: string): number;
	truncate(text: string, maxWidth: number): string;
}

export interface CollapsedDiffHintOptions {
	remainingLines: number;
	hiddenHunks: number;
	expanded?: boolean;
}

function guardSafeWidth(width: number): number | undefined {
	const safe = normalizeDiffRenderWidth(width);
	return safe === 0 ? undefined : safe;
}

function renderWithSafeWidth<T>(
	width: number,
	fallback: T,
	render: (safeWidth: number) => T,
): T {
	const safeWidth = guardSafeWidth(width);
	if (safeWidth === undefined) {
		return fallback;
	}
	return render(safeWidth);
}

export function clampRenderedLineToWidth(
	text: string,
	width: number,
	ops: WidthMeasurementOps,
): string {
	return renderWithSafeWidth(width, "", (safeWidth) => {
		if (ops.measure(text) <= safeWidth) {
			return text;
		}

		for (let targetWidth = safeWidth; targetWidth >= 0; targetWidth--) {
			const candidate = ops.truncate(text, targetWidth);
			if (ops.measure(candidate) <= safeWidth) {
				return candidate;
			}
		}

		return "";
	});
}

export function clampRenderedLinesToWidth(
	lines: string[],
	width: number,
	ops: WidthMeasurementOps,
): string[] {
	return lines.map((line) => clampRenderedLineToWidth(line, width, ops));
}

export function buildCollapsedDiffHintText(
	options: CollapsedDiffHintOptions,
	width: number,
	ops: WidthMeasurementOps,
): string {
	return renderWithSafeWidth(width, "", (safeWidth) => {
		const remainingText = `${options.remainingLines} more ${pluralize(options.remainingLines, "visual diff line")}`;
		const hiddenHunksText = options.hiddenHunks > 0
			? `${options.hiddenHunks} more ${pluralize(options.hiddenHunks, "hunk")}`
			: undefined;
		const action = options.expanded ? "display capped" : "Ctrl+O to expand";

		const candidates = [
			`… (${[remainingText, hiddenHunksText, action].filter(Boolean).join(" • ")})`,
			`… (${[remainingText, hiddenHunksText].filter(Boolean).join(" • ")})`,
			options.hiddenHunks > 0
				? `… (+${options.remainingLines} • +${options.hiddenHunks}h)`
				: `… (+${options.remainingLines})`,
			"…",
		];

		for (const candidate of candidates) {
			if (ops.measure(candidate) <= safeWidth) {
				return candidate;
			}
		}

		return clampRenderedLineToWidth(candidates[candidates.length - 1] ?? "", safeWidth, ops);
	});
}
