import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBinding } from "./bindings.ts";
import type { AnnotationAck, AnnotationConfig, AnnotationTransport } from "./annotations.ts";
import { execJson } from "./client.ts";
import { browserTargetPresent, isMissingBrowserWorkspace } from "./targets.ts";

const TIMEOUT_MS = 4000;
const RUNTIME = "__piCmuxAnnotationsV1";
let overlaySource: string | undefined;

export function annotationInstallScript(config: AnnotationConfig): string {
	overlaySource ??= readFileSync(new URL("./overlay.js", import.meta.url), "utf8");
	return `(() => { ${overlaySource}\nreturn installPiAnnotations(${JSON.stringify(config)}); })()`;
}

export class CmuxAnnotationTransport implements AnnotationTransport {
	private pi: Pick<ExtensionAPI, "exec">;
	private removed?: (binding: BrowserBinding) => void;
	constructor(pi: Pick<ExtensionAPI, "exec">, removed?: (binding: BrowserBinding) => void) {
		this.pi = pi;
		this.removed = removed;
	}

	private rpc(method: string, params: object, signal: AbortSignal): Promise<Record<string, unknown>> {
		return execJson(this.pi, ["--json", "--id-format", "both", "rpc", method, JSON.stringify(params)], TIMEOUT_MS, signal);
	}

	/** Never infer a replacement from focus, display refs, or a moved/closed pane. */
	private async verify(binding: BrowserBinding, signal: AbortSignal): Promise<void> {
		let listing: Record<string, unknown>;
		try {
			listing = await this.rpc("surface.list", { window_id: binding.windowId, workspace_id: binding.workspaceId }, signal);
		} catch (error) {
			if (!signal.aborted && isMissingBrowserWorkspace(error)) this.removed?.(binding);
			throw error;
		}
		if (!browserTargetPresent(binding, listing)) {
			if (!signal.aborted) this.removed?.(binding);
			throw new Error("Browser or source terminal is no longer in its bound workspace");
		}
		const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b;
		const mode = await this.rpc("browser.design_mode.status", { workspace_id: binding.workspaceId, surface_id: binding.surfaceId }, signal);
		if (!same(mode.surface_id, binding.surfaceId) || !same(mode.workspace_id, binding.workspaceId) || mode.enabled !== false) {
			throw new Error("Turn off native cmux Design Mode before using Pi annotations; native drafts are left untouched");
		}
	}

	private async evaluate(binding: BrowserBinding, script: string, signal: AbortSignal): Promise<unknown> {
		await this.verify(binding, signal);
		const result = await this.rpc("browser.eval", { workspace_id: binding.workspaceId, surface_id: binding.surfaceId, script }, signal);
		if (typeof result.surface_id !== "string" || result.surface_id.toLowerCase() !== binding.surfaceId
			|| typeof result.workspace_id !== "string" || result.workspace_id.toLowerCase() !== binding.workspaceId) {
			throw new Error("Browser evaluation target mismatch");
		}
		if (JSON.stringify(result.value)?.length > 16_384) throw new Error("Annotation response is too large");
		return result.value;
	}

	install(binding: BrowserBinding, config: AnnotationConfig, signal: AbortSignal): Promise<unknown> {
		return this.evaluate(binding, annotationInstallScript(config), signal);
	}

	read(binding: BrowserBinding, owner: string, acks: AnnotationAck[], signal: AbortSignal): Promise<unknown> {
		return this.evaluate(binding, `(() => { const api = globalThis.${RUNTIME}; return api ? api.poll(${JSON.stringify(owner)}, ${JSON.stringify(acks)}) : { missing: true }; })()`, signal);
	}

	async disconnect(binding: BrowserBinding, owner: string, signal: AbortSignal): Promise<void> {
		await this.evaluate(binding, `globalThis.${RUNTIME}?.disconnect(${JSON.stringify(owner)}) ?? null`, signal);
	}
}
