import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildContextualTabTitle, buildShellCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";
import { onI18nLocaleChanged, t, type I18nKey } from "./i18n.ts";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_SECTION_NAME = "pi-cmux";
const RESERVED_COMMAND_NAMES = new Set([
	"login",
	"logout",
	"model",
	"scoped-models",
	"settings",
	"resume",
	"new",
	"name",
	"session",
	"tree",
	"fork",
	"compact",
	"copy",
	"export",
	"share",
	"reload",
	"hotkeys",
	"changelog",
	"quit",
	"exit",
	"help",
	"cmv",
	"cmux-v",
	"cmh",
	"cmux-h",
	"cmo",
	"cmov",
	"cmoh",
	"cmz",
	"cmzh",
	"z",
	"zh",
	"cmrv",
	"cmrh",
	"review-v",
	"review-h",
	"cmcv",
	"cmch",
]);

interface ConfiguredSplitCommandInput {
	run?: string;
	acceptArgs?: boolean;
	direction?: string;
	title?: string;
	description?: string;
	disabled?: boolean;
}

interface ConfiguredSplitCommand {
	run: string;
	acceptArgs: boolean;
	direction: SplitDirection;
	title?: string;
	description: string;
}

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
	title?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool"),
	});
}

function registerOpenCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	descriptionKey: I18nKey,
	successKey: I18nKey,
): void {
	pi.registerCommand(name, {
		description: t(descriptionKey),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInSplit(pi, ctx, direction, command);
			if (result.ok) {
				ctx.ui.notify(t(successKey), "info");
			} else {
				ctx.ui.notify(t("open.failed", { error: result.error }), "error");
			}
		},
	});
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`[pi-cmux] Ignoring non-object settings file: ${path}`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-cmux] Failed to read settings from ${path}: ${message}`);
		return undefined;
	}
}

function readPiCmuxCommands(settingsPath: string): Record<string, unknown> {
	const settings = readJsonFile(settingsPath);
	const section = settings?.[SETTINGS_SECTION_NAME];
	if (!section) {
		return {};
	}
	if (typeof section !== "object" || Array.isArray(section)) {
		console.warn(`[pi-cmux] Ignoring invalid \"${SETTINGS_SECTION_NAME}\" settings in ${settingsPath}`);
		return {};
	}

	const commands = (section as { commands?: unknown }).commands;
	if (commands === undefined) {
		return {};
	}
	if (typeof commands !== "object" || Array.isArray(commands)) {
		console.warn(`[pi-cmux] Ignoring invalid \"${SETTINGS_SECTION_NAME}.commands\" settings in ${settingsPath}`);
		return {};
	}

	return commands as Record<string, unknown>;
}

function isValidCommandName(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function getDefaultConfiguredCommandDescription(commandName: string, run: string): string {
	return `Open ${run} in a cmux split via /${commandName}`;
}

function normalizeSplitDirection(
	value: unknown,
	commandName: string,
	settingsPath: string,
): SplitDirection | undefined {
	if (value === undefined) {
		return "right";
	}
	if (value === "right" || value === "down") {
		return value;
	}

	console.warn(
		`[pi-cmux] Skipping configured command /${commandName} with invalid direction from ${settingsPath}; expected \"right\" or \"down\"`,
	);
	return undefined;
}

function normalizeConfiguredSplitCommand(
	commandName: string,
	value: unknown,
	settingsPath: string,
): ConfiguredSplitCommand | null | undefined {
	if (!isValidCommandName(commandName)) {
		console.warn(`[pi-cmux] Skipping invalid configured command name \"${commandName}\" from ${settingsPath}`);
		return undefined;
	}

	if (typeof value === "string") {
		const run = value.trim();
		if (!run) {
			console.warn(`[pi-cmux] Skipping empty configured command /${commandName} from ${settingsPath}`);
			return undefined;
		}
		return {
			run,
			acceptArgs: false,
			direction: "right",
			description: getDefaultConfiguredCommandDescription(commandName, run),
		};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`[pi-cmux] Skipping invalid configured command /${commandName} from ${settingsPath}`);
		return undefined;
	}

	const config = value as ConfiguredSplitCommandInput;
	if (config.disabled) {
		return null;
	}

	const run = typeof config.run === "string" ? config.run.trim() : "";
	if (!run) {
		console.warn(`[pi-cmux] Skipping configured command /${commandName} without a valid \"run\" value from ${settingsPath}`);
		return undefined;
	}

	const direction = normalizeSplitDirection(config.direction, commandName, settingsPath);
	if (!direction) {
		return undefined;
	}

	const title = typeof config.title === "string" && config.title.trim().length > 0 ? config.title.trim() : undefined;

	return {
		run,
		acceptArgs: config.acceptArgs === true,
		direction,
		title,
		description:
			typeof config.description === "string" && config.description.trim().length > 0
				? config.description.trim()
				: getDefaultConfiguredCommandDescription(commandName, run),
	};
}

function loadConfiguredSplitCommands(cwd: string): Map<string, ConfiguredSplitCommand> {
	const configuredCommands = new Map<string, ConfiguredSplitCommand>();
	const settingsPaths = [GLOBAL_SETTINGS_PATH, join(cwd, ".pi", "settings.json")];

	for (const settingsPath of settingsPaths) {
		const commands = readPiCmuxCommands(settingsPath);
		for (const [commandName, value] of Object.entries(commands)) {
			const normalized = normalizeConfiguredSplitCommand(commandName, value, settingsPath);
			if (normalized === null) {
				configuredCommands.delete(commandName);
				continue;
			}
			if (!normalized) {
				continue;
			}
			configuredCommands.set(commandName, normalized);
		}
	}

	return configuredCommands;
}

function registerConfiguredSplitCommand(
	pi: ExtensionAPI,
	commandName: string,
	config: ConfiguredSplitCommand,
): void {
	pi.registerCommand(commandName, {
		description: config.description,
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs.length > 0 && !config.acceptArgs) {
				ctx.ui.notify(`Usage: /${commandName}`, "warning");
				return;
			}

			const command = trimmedArgs.length > 0 ? `${config.run} ${trimmedArgs}` : config.run;
			const result = await openToolInSplit(pi, ctx, config.direction, command, config.title ?? config.run);
			if (result.ok) {
				const location = config.direction === "right" ? "to the right" : "below";
				ctx.ui.notify(`Opened /${commandName} split ${location}`, "info");
			} else {
				ctx.ui.notify(`configured command failed: ${result.error}`, "error");
			}
		},
	});
}

function registerOpenCommands(pi: ExtensionAPI): void {
	registerOpenCommand(
		pi,
		"cmo",
		"right",
		"open.right.description",
		"open.success.right",
	);
	registerOpenCommand(
		pi,
		"cmov",
		"right",
		"open.alias.cmo",
		"open.success.right",
	);

	registerOpenCommand(
		pi,
		"cmoh",
		"down",
		"open.down.description",
		"open.success.down",
	);
}

function registerConfiguredSplitCommands(pi: ExtensionAPI): void {
	const registeredConfiguredNames = new Set<string>();
	for (const [commandName, config] of loadConfiguredSplitCommands(process.cwd())) {
		const normalizedName = commandName.toLowerCase();
		if (RESERVED_COMMAND_NAMES.has(normalizedName) || registeredConfiguredNames.has(normalizedName)) {
			console.warn(`[pi-cmux] Skipping configured command /${commandName}: command already exists`);
			continue;
		}
		registerConfiguredSplitCommand(pi, commandName, config);
		registeredConfiguredNames.add(normalizedName);
	}
}

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommands(pi);
	registerConfiguredSplitCommands(pi);
	onI18nLocaleChanged(pi, () => {
		registerOpenCommands(pi);
	});
}
