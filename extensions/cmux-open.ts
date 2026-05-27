import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContextualTabTitle, buildShellCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";
import { onI18nLocaleChanged, t, type I18nKey } from "./i18n.ts";

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, command, "Tool"),
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

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommands(pi);
	onI18nLocaleChanged(pi, () => {
		registerOpenCommands(pi);
	});
}
