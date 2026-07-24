import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import type { ToolDisplayPreset } from "./presets.js";
import type { ToolDisplayConfig, ToolDisplayConfigPatch } from "./types.js";

export type ToolDisplayConfigMutation =
	| { type: "patch"; patch: ToolDisplayConfigPatch }
	| { type: "preset"; preset: ToolDisplayPreset }
	| { type: "reset" };

export interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	mutateConfig(mutation: ToolDisplayConfigMutation, ctx: ExtensionCommandContext): void;
	getCapabilities(): ToolDisplayCapabilities;
}

export function registerToolDisplayCommand(pi: ExtensionAPI, controller: ToolDisplayConfigController): void {
	pi.registerCommand("tool-display", {
		description: "Configure pure TUI display rendering",
		handler: async (args, ctx) => {
			const { runToolDisplayCommandHandler } = await import("./config-modal.js");
			await runToolDisplayCommandHandler(args, ctx, controller);
		},
	});
}
