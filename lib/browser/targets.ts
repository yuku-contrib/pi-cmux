import type { BrowserBinding } from "./bindings.ts";

/** Only a valid inventory can prove a target disappeared; malformed replies are errors. */
export function browserTargetPresent(binding: BrowserBinding, listing: Record<string, unknown>): boolean {
	const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
	const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
	// Allow future surface kinds, but never treat malformed type tokens as closure.
	const surfaceType = (value: unknown) => typeof value === "string" && /^[a-z]/i.test(value) && !/[^a-z0-9_-]/i.test(value);
	if (!uuid(listing.window_id) || !uuid(listing.workspace_id)
		|| !Array.isArray(listing.surfaces) || listing.surfaces.some(s => !s || typeof s !== "object" || !uuid(s.id)
			|| !surfaceType(s.type))) {
		throw new Error("Invalid browser surface inventory");
	}
	if (!same(listing.window_id, binding.windowId) || !same(listing.workspace_id, binding.workspaceId)) return false;
	const browser = listing.surfaces.filter(s => same(s.id, binding.surfaceId));
	const source = listing.surfaces.filter(s => same(s.id, binding.sourceSurfaceId));
	if (browser.length > 1 || source.length > 1) throw new Error("Ambiguous browser surface inventory");
	if (browser.length && browser[0].type === "browser" && !uuid(browser[0].pane_id)) throw new Error("Invalid browser pane inventory");
	return browser.length === 1 && browser[0].type === "browser" && same(browser[0].pane_id, binding.paneId)
		&& source.length === 1 && source[0].type === "terminal";
}

/** Do not confuse CLI failures, timeouts, or unsupported methods with closed targets. */
export function isMissingBrowserWorkspace(error: unknown): boolean {
	return error instanceof Error && /^(?:Error: )?not_found: (?:Workspace|Window) not found\.?$/i.test(error.message.trim());
}
