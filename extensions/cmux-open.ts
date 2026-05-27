import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildShellCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";
import { t } from "./i18n.ts";

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, args.trim()));
}

function registerOpenCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInSplit(pi, ctx, direction, command);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(t("open.failed", { error: result.error }), "error");
			}
		},
	});
}

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommand(
		pi,
		"cmo",
		"right",
		t("open.right.description"),
		t("open.success.right"),
	);
	registerOpenCommand(
		pi,
		"cmov",
		"right",
		t("open.alias.cmo"),
		t("open.success.right"),
	);

	registerOpenCommand(
		pi,
		"cmoh",
		"down",
		t("open.down.description"),
		t("open.success.down"),
	);
}
