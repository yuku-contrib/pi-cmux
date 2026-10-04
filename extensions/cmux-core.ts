import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;
const TAB_TITLE_CONTEXT_TIMEOUT_MS = 1000;
const MAX_TAB_TITLE_LENGTH = 48;
const TAB_TITLE_SEPARATOR = " · ";

export type SplitDirection = "right" | "down";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiCommandOptions {
	sessionFile?: string;
	prompt?: string;
	provider?: string;
	model?: string;
	thinking?: PiThinkingLevel;
}

interface CmuxCallerInfo {
	window_ref?: string;
	workspace_ref?: string;
	pane_ref?: string;
	surface_ref?: string;
}

interface CmuxCallerContext {
	window_ref?: string;
	workspace_ref: string;
	surface_ref: string;
	pane_ref?: string;
}

interface CmuxIdentifyResponse {
	caller?: CmuxCallerInfo;
}

interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

interface CmuxListPanesResponse {
	panes?: CmuxPaneInfo[];
}

interface CmuxSurfaceCreationResponse {
	surface_ref?: unknown;
	surface_id?: unknown;
}

interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface OpenCommandInNewSplitOptions {
	tabTitle?: string;
	focus?: boolean;
}

export interface OpenCommandInNewTabOptions {
	tabTitle?: string;
	focus?: boolean;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function getCreatedSurfaceRef(stdout: string): string | undefined {
	const parsed = parseJson<CmuxSurfaceCreationResponse>(stdout);
	for (const value of [parsed?.surface_ref, parsed?.surface_id]) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCommandPrefix(cwd: string): string[] {
	const commandParts = ["cd", shellEscape(cwd), "&&"];
	// cmux respawns from the app's environment, which may have a different PATH.
	if (process.env.PATH !== undefined) {
		commandParts.push(`PATH=${shellEscape(process.env.PATH)}`);
	}
	commandParts.push("exec");
	return commandParts;
}

export function buildPiCommand(cwd: string, options?: PiCommandOptions): string {
	const commandParts = [...buildCommandPrefix(cwd), "pi"];
	if (options?.sessionFile) {
		commandParts.push("--session", shellEscape(options.sessionFile));
	}
	if (options?.provider) {
		commandParts.push("--provider", shellEscape(options.provider));
	}
	if (options?.model) {
		commandParts.push("--model", shellEscape(options.model));
	}
	if (options?.thinking) {
		commandParts.push("--thinking", shellEscape(options.thinking));
	}
	const prompt = options?.prompt?.trim();
	if (prompt) {
		commandParts.push("--", shellEscape(prompt));
	}
	return commandParts.join(" ");
}

export function buildShellCommand(cwd: string, command: string): string {
	// This inner shell is non-login. cmux respawn-pane may wrap the whole command
	// in a login shell; the prefix restores PATH, but cannot prevent profile side effects.
	return [...buildCommandPrefix(cwd), "/bin/sh", "-c", shellEscape(command)].join(" ");
}

function normalizeTabTitle(value: string | undefined, fallback: string): string {
	return (value ?? "").replace(/\s+/g, " ").trim() || fallback.replace(/\s+/g, " ").trim();
}

export function formatTabTitle(value: string | undefined, fallback: string): string {
	const title = normalizeTabTitle(value, fallback);
	if (title.length <= MAX_TAB_TITLE_LENGTH) {
		return title;
	}
	return `${title.slice(0, MAX_TAB_TITLE_LENGTH - 3).trimEnd()}...`;
}

async function getTabTitleContext(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: TAB_TITLE_CONTEXT_TIMEOUT_MS,
		});
		const repoRoot = result.code === 0 && !result.killed ? result.stdout.trim() : "";
		if (repoRoot) {
			return basename(repoRoot) || repoRoot;
		}
	} catch {
		// Fall through to directory basename.
	}

	return basename(cwd) || cwd;
}

export async function buildContextualTabTitle(
	pi: ExtensionAPI,
	cwd: string,
	value: string | undefined,
	fallback: string,
): Promise<string> {
	const title = normalizeTabTitle(value, fallback);
	const context = normalizeTabTitle(await getTabTitleContext(pi, cwd), "");
	return formatTabTitle(context ? `${title}${TAB_TITLE_SEPARATOR}${context}` : title, title);
}

function collectSurfaceRefs(panes: CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) {
			refs.add(pane.selected_surface_ref);
		}
		for (const surfaceRef of pane.surface_refs ?? []) {
			refs.add(surfaceRef);
		}
	}
	return refs;
}

export async function execCmux(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<CmuxExecResult> {
	const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS, ...(signal ? { signal } : {}) });
	if (result.killed) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: "cmux command timed out",
		};
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`,
		};
	}
	return {
		ok: true,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export async function getCallerInfo(pi: ExtensionAPI, signal?: AbortSignal): Promise<{ ok: true; caller: CmuxCallerContext } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "identify"], signal);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to identify cmux caller" };
	}

	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) {
		return { ok: false, error: "This command must be run from inside a cmux surface" };
	}

	return {
		ok: true,
		caller: {
			window_ref: parsed?.caller?.window_ref,
			workspace_ref: workspaceRef,
			surface_ref: surfaceRef,
			pane_ref: parsed?.caller?.pane_ref,
		},
	};
}

async function listPanes(pi: ExtensionAPI, workspaceRef: string): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to list cmux panes" };
	}

	const parsed = parseJson<CmuxListPanesResponse>(result.stdout);
	if (!Array.isArray(parsed?.panes) || parsed.panes.some((pane) =>
		!pane || typeof pane !== "object" ||
		typeof pane.ref !== "string" || !pane.ref.trim() ||
		(pane.selected_surface_ref != null && typeof pane.selected_surface_ref !== "string") ||
		(pane.surface_refs != null && (!Array.isArray(pane.surface_refs) ||
			pane.surface_refs.some((ref) => typeof ref !== "string" || !ref.trim())))
	)) {
		return { ok: false, error: "Invalid cmux pane list response" };
	}
	return { ok: true, panes: parsed.panes };
}

async function waitForNewSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	previousPanes: CmuxPaneInfo[],
	paneRef?: string,
): Promise<string | undefined> {
	const previousPaneRefs = new Set(previousPanes.map((pane) => pane.ref));
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < SPLIT_READY_ATTEMPTS; attempt += 1) {
		const panesResult = await listPanes(pi, workspaceRef);
		if (!panesResult.ok) {
			return undefined;
		}

		// A tab belongs in its caller's pane; a split must create a new pane.
		const panes = panesResult.panes.filter((pane) => paneRef
			? pane.ref === paneRef
			: !previousPaneRefs.has(pane.ref));
		const newSurfaceRefs = [...collectSurfaceRefs(panes)].filter((ref) => !previousSurfaceRefs.has(ref));
		// Legacy output cannot correlate concurrent creations. Never choose the first match.
		if (panes.length > 1 || newSurfaceRefs.length > 1) return undefined;
		if (newSurfaceRefs.length === 1) return newSurfaceRefs[0];

		await delay(SPLIT_READY_DELAY_MS);
	}

	return undefined;
}

async function renameSurfaceTab(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, title: string | undefined): Promise<void> {
	const tabTitle = formatTabTitle(title, "");
	if (!tabTitle) {
		return;
	}

	try {
		await execCmux(pi, [
			"rename-tab",
			"--workspace",
			workspaceRef,
			"--surface",
			surfaceRef,
			"--title",
			tabTitle,
		]);
	} catch {
		// Tab naming is best-effort; the spawned split is still useful if rename fails.
	}
}

async function respawnSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	surfaceRef: string,
	command: string,
	failureMessage: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const respawnResult = await execCmux(pi, [
		"respawn-pane",
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
		"--command",
		command,
	]);
	if (!respawnResult.ok) {
		return { ok: false, error: respawnResult.error || failureMessage };
	}

	return { ok: true };
}

export async function openCommandInNewWorkspace(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	options: { title: string; focus?: boolean },
): Promise<{ ok: true; workspaceRef?: string } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return callerResult;
	const windowRef = callerResult.caller.window_ref;
	if (typeof windowRef !== "string" || !windowRef.trim()) {
		return { ok: false, error: "Could not identify the calling cmux window safely" };
	}

	// Do not pass --command here: some cmux versions type it into an interactive
	// shell. Respawn only the returned workspace's surface, like splits and tabs.
	const result = await execCmux(pi, [
		// The legacy new-workspace verb ignores --json on cmux 0.64.25.
		"--json", "workspace", "create",
		"--window", windowRef,
		"--cwd", cwd,
		"--name", formatTabTitle(options.title, "Pi"),
		"--focus", String(options.focus ?? true),
	]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to create cmux workspace" };
	}

	const parsed = parseJson<{ workspace_ref?: unknown; workspace_id?: unknown }>(result.stdout);
	const workspaceRef = [parsed?.workspace_ref, parsed?.workspace_id]
		.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
	if (!workspaceRef || workspaceRef === callerResult.caller.workspace_ref) {
		return { ok: false, error: "Created workspace, but could not identify the new cmux workspace safely" };
	}
	const surfaceRef = getCreatedSurfaceRef(result.stdout) ?? await waitForNewSurface(pi, workspaceRef, []);
	if (!surfaceRef || surfaceRef === callerResult.caller.surface_ref) {
		return { ok: false, error: "Created workspace, but could not identify its new cmux surface safely" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);
	const respawnResult = await respawnSurface(pi, workspaceRef, surfaceRef, command, "Failed to start Pi in the new workspace");
	if (!respawnResult.ok) return respawnResult;
	await renameSurfaceTab(pi, workspaceRef, surfaceRef, options.title);
	return { ok: true, workspaceRef };
}

export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
	options: OpenCommandInNewSplitOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	// Keep a pre-creation snapshot only for the legacy discovery fallback.
	const beforePanesResult = await listPanes(pi, workspaceRef);

	const splitArgs = [
		"--json",
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
	];
	if (options.focus !== undefined) {
		splitArgs.push("--focus", String(options.focus));
	}

	const splitResult = await execCmux(pi, splitArgs);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error || "Failed to create cmux split" };
	}

	const newSurfaceRef = getCreatedSurfaceRef(splitResult.stdout) ??
		(beforePanesResult.ok ? await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes) : undefined);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created split, but could not identify the new cmux surface safely" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start pi in the new split");
	if (!respawnResult.ok) {
		return respawnResult;
	}

	await renameSurfaceTab(pi, workspaceRef, newSurfaceRef, options.tabTitle);

	return { ok: true };
}

export async function openCommandInNewTab(
	pi: ExtensionAPI,
	command: string,
	options: OpenCommandInNewTabOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspace_ref: workspaceRef, pane_ref: paneRef } = callerResult.caller;
	if (!paneRef) {
		return { ok: false, error: "This command must be run from inside a cmux pane" };
	}

	// Keep a pre-creation snapshot only for the legacy discovery fallback.
	const beforePanesResult = await listPanes(pi, workspaceRef);

	const newSurfaceResult = await execCmux(pi, [
		"--json",
		"new-surface",
		"--type",
		"terminal",
		"--workspace",
		workspaceRef,
		"--pane",
		paneRef,
		"--focus",
		String(options.focus ?? true),
	]);
	if (!newSurfaceResult.ok) {
		return { ok: false, error: newSurfaceResult.error || "Failed to create cmux tab" };
	}

	const newSurfaceRef = getCreatedSurfaceRef(newSurfaceResult.stdout) ??
		(beforePanesResult.ok ? await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes, paneRef) : undefined);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created tab, but could not identify the new cmux surface safely" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start command in the new tab");
	if (!respawnResult.ok) {
		return respawnResult;
	}

	await renameSurfaceTab(pi, workspaceRef, newSurfaceRef, options.tabTitle);

	return { ok: true };
}
