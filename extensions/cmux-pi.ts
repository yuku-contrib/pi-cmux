import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildContextualTabTitle,
	buildPiCommand,
	openCommandInNewSplit,
	openCommandInNewTab,
	openCommandInNewWorkspace,
	type PiCommandOptions,
	type SplitDirection,
} from "./cmux-core.ts";

export type PiPlacement = "workspace" | "tab" | SplitDirection;

export interface PiLaunchOptions extends PiCommandOptions {
	placement?: PiPlacement;
	title?: string;
	focus?: boolean;
}

export const PI_LAUNCH_PROPERTIES = {
	placement: {
		type: "string", enum: ["workspace", "right", "down", "tab"], default: "workspace",
		description: "Where to start Pi. workspace creates a separate sidebar entry; tab stays in the current workspace.",
	},
	provider: { type: "string", description: "Optional Pi provider. Requires model; omit both to use Pi's normal model selection." },
	model: { type: "string", description: "Optional Pi model pattern or ID, including provider/model and model:thinking forms." },
	thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Optional Pi thinking level." },
	title: { type: "string", description: "Short task title for the sidebar workspace or tab." },
	focus: { type: "boolean", default: true, description: "Focus the new workspace or terminal. Set false to open it in the background." },
} as const;

export function validatePiLaunchOptions(options: PiLaunchOptions): void {
	if (!["workspace", "right", "down", "tab"].includes(options.placement ?? "workspace")) {
		throw new Error("Invalid Pi placement");
	}
	if (options.provider?.trim() && !options.model?.trim()) throw new Error("provider requires model");
}

export function describePiPlacement(placement: PiPlacement): string {
	return placement === "workspace" ? "sidebar workspace" : placement === "tab" ? "tab" : `${placement} split`;
}

export async function openPiSession(pi: ExtensionAPI, cwd: string, options: PiLaunchOptions, fallbackTitle = "Pi") {
	validatePiLaunchOptions(options);
	const placement = options.placement ?? "workspace";
	const title = await buildContextualTabTitle(pi, cwd, options.title || options.prompt, fallbackTitle);
	const command = buildPiCommand(cwd, { ...options, provider: options.provider?.trim(), model: options.model?.trim() });
	const focus = options.focus ?? true;
	const result = placement === "workspace"
		? await openCommandInNewWorkspace(pi, cwd, command, { title, focus })
		: placement === "tab"
			? await openCommandInNewTab(pi, command, { tabTitle: title, focus })
			: await openCommandInNewSplit(pi, placement, command, { tabTitle: title, focus });
	if (!result.ok) return result;
	return {
		ok: true as const,
		placement, cwd, title,
		workspaceRef: "workspaceRef" in result ? result.workspaceRef : undefined,
	};
}
