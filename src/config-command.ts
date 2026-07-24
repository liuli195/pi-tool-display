import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import type { ToolDisplayConfig } from "./types.js";

export interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	setConfig(next: ToolDisplayConfig, ctx: ExtensionCommandContext): void;
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
