import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const TIMEOUT_MS = 120_000;

/** A short preview, never a full-screen review or an automatic approval. */
export async function confirmAnnotation(ctx: ExtensionContext, comment: string, signal: AbortSignal): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
	const preview = stripVTControlCharacters(truncateToWidth(comment
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
		.replace(/\s+/gu, " ").trim(), 60, "…"));
	const choice = await ctx.ui.select(
		`Send full note + page context to Pi?\nPreview: ${preview}\nPage scripts can forge notes. Only send your own.`,
		["Cancel", "Send to Pi"],
		{ signal: deadline, timeout: TIMEOUT_MS },
	);
	return !deadline.aborted && choice === "Send to Pi" ? choice : undefined;
}
