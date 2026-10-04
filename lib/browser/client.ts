import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IDENTIFY_TIMEOUT_MS = 5_000;
const CREATE_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BrowserPlacement = "right" | "down";

export interface BrowserOpenOptions {
	url: string;
	placement?: BrowserPlacement;
	focus?: boolean;
}

export interface OpenedBrowser {
	windowId: string;
	workspaceId: string;
	sourceSurfaceId: string;
	surfaceId: string;
	paneId: string;
	surfaceRef?: string;
	url: string;
	placement: BrowserPlacement;
	focus: boolean;
}

export function normalizeBrowserOptions(options: BrowserOpenOptions): Required<BrowserOpenOptions> {
	if (!options || typeof options.url !== "string") throw new Error("Specify a browser URL");
	const value = options.url.trim();
	if (!value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error("Specify a URL without whitespace or control characters (maximum 8192 characters)");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Specify an absolute http://, https://, or local file:// URL");
	}
	if (!/^(https?|file):\/\//i.test(value) || !["http:", "https:", "file:"].includes(url.protocol)
		|| (url.protocol === "file:" && url.hostname !== "" && url.hostname !== "localhost")) {
		throw new Error("Only http://, https://, and local file:// URLs are supported");
	}
	if (url.username || url.password) throw new Error("Browser URLs must not contain credentials");
	if (options.placement !== undefined && options.placement !== "right" && options.placement !== "down") {
		throw new Error("Browser placement must be right or down");
	}
	if (options.focus !== undefined && typeof options.focus !== "boolean") {
		throw new Error("Browser focus must be a boolean");
	}
	return { url: url.href, placement: options.placement ?? "right", focus: options.focus ?? false };
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cmux JSON response");
	return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Missing or invalid cmux ${field}`);
	return value.toLowerCase();
}

export async function execJson(
	pi: Pick<ExtensionAPI, "exec">,
	args: string[],
	timeout: number,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	signal?.throwIfAborted();
	const result = await pi.exec("cmux", args, { timeout, signal });
	signal?.throwIfAborted();
	if (result.killed) throw new Error(`cmux command timed out after ${timeout}ms`);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`);
	}
	if (result.stdout.length > 1_048_576) throw new Error("cmux JSON response is too large");
	try {
		return object(JSON.parse(result.stdout));
	} catch {
		throw new Error("Invalid cmux JSON response");
	}
}

/** Create exactly one browser split. Never discover a replacement by focus or retry creation. */
export async function openBrowserSplit(
	pi: Pick<ExtensionAPI, "exec">,
	options: BrowserOpenOptions,
	signal?: AbortSignal,
): Promise<OpenedBrowser> {
	const normalized = normalizeBrowserOptions(options);
	const identified = await execJson(pi, ["--json", "--id-format", "both", "identify"], IDENTIFY_TIMEOUT_MS, signal);
	if (!identified.caller) throw new Error("Open the browser from a Pi terminal inside cmux");
	const caller = object(identified.caller);
	if (caller.surface_type !== "terminal") throw new Error("The cmux caller must be a terminal surface");
	const windowId = uuid(caller.window_id, "caller window_id");
	const workspaceId = uuid(caller.workspace_id, "caller workspace_id");
	const sourceSurfaceId = uuid(caller.surface_id, "caller surface_id");
	const sourcePaneId = uuid(caller.pane_id, "caller pane_id");
	signal?.throwIfAborted();
	try {
		const created = await execJson(pi, ["--json", "rpc", "pane.create", JSON.stringify({
			window_id: windowId,
			workspace_id: workspaceId,
			surface_id: sourceSurfaceId,
			type: "browser",
			direction: normalized.placement,
			url: normalized.url,
			focus: normalized.focus,
		})], CREATE_TIMEOUT_MS, signal);
		const surfaceId = uuid(created.surface_id, "created surface_id");
		const paneId = uuid(created.pane_id, "created pane_id");
		if (uuid(created.window_id, "created window_id") !== windowId
			|| uuid(created.workspace_id, "created workspace_id") !== workspaceId
			|| surfaceId === sourceSurfaceId || paneId === sourcePaneId || created.type !== "browser") {
			throw new Error("cmux returned an unexpected browser target");
		}
		return {
			windowId, workspaceId, sourceSurfaceId, surfaceId, paneId,
			surfaceRef: typeof created.surface_ref === "string" && /^surface:[1-9][0-9]*$/.test(created.surface_ref)
				? created.surface_ref : undefined,
			...normalized,
		};
	} catch (error) {
		// The server may have created a pane before timeout, cancellation, or invalid output.
		// Do not close an unverified target or retry a non-idempotent creation.
		throw new Error(`Browser creation was not confirmed: ${error instanceof Error ? error.message : String(error)}. A browser split may already exist; inspect cmux before retrying.`);
	}
}
