import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBinding } from "./bindings.ts";
import { execJson } from "./client.ts";
import { openBrowserEvents, type BrowserEventFrame, type OpenBrowserEvents } from "./events.ts";
import { browserTargetPresent, isMissingBrowserWorkspace } from "./targets.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown): string | undefined { return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined; }

/** One lazy event subscription per Pi session, shared by all its bound browsers. */
export class BrowserLifecycle {
	private bindings = new Map<string, BrowserBinding>();
	private controller = new AbortController();
	private disconnect?: () => void;
	private reconnect?: ReturnType<typeof setTimeout>;
	private backoff = 1000;
	private inventoryRetry?: ReturnType<typeof setTimeout>;
	private inventoryBackoff = 1000;
	private boot?: string;
	private sequence = -1;
	private checking = false;
	private dirty = false;

	private pi: Pick<ExtensionAPI, "exec">;
	private removed: (binding: BrowserBinding) => void;
	private openEvents: OpenBrowserEvents;

	constructor(pi: Pick<ExtensionAPI, "exec">, removed: (binding: BrowserBinding) => void, openEvents: OpenBrowserEvents = openBrowserEvents) {
		this.pi = pi;
		this.removed = removed;
		this.openEvents = openEvents;
	}

	track(binding: BrowserBinding): void {
		if (this.controller.signal.aborted) this.controller = new AbortController();
		this.bindings.set(binding.surfaceId, binding);
		this.connect();
		// Covers a close between creation and subscription, including unavailable events.
		void this.reconcile();
	}

	forget(binding: BrowserBinding): void {
		if (this.bindings.get(binding.surfaceId) !== binding) return;
		this.bindings.delete(binding.surfaceId);
		if (!this.bindings.size) this.stop();
	}

	stop(): void {
		this.controller.abort();
		this.disconnect?.();
		this.disconnect = undefined;
		clearTimeout(this.reconnect);
		this.reconnect = undefined;
		clearTimeout(this.inventoryRetry);
		this.inventoryRetry = undefined;
		this.inventoryBackoff = 1000;
		this.bindings.clear();
		this.boot = undefined;
		this.sequence = -1;
		this.backoff = 1000;
		this.checking = false;
		this.dirty = false;
	}

	private drop(binding: BrowserBinding): void {
		if (this.bindings.get(binding.surfaceId) !== binding) return;
		this.forget(binding);
		this.removed(binding);
	}

	private connect(): void {
		if (this.disconnect || this.reconnect || !this.bindings.size) return;
		const signal = this.controller.signal;
		let connected = true;
		const failed = () => {
			if (!connected || signal.aborted) return;
			connected = false;
			this.disconnect = undefined;
			this.reconnect = setTimeout(() => {
				this.reconnect = undefined;
				if (!signal.aborted) this.connect();
			}, this.backoff);
			this.reconnect.unref();
			this.backoff = Math.min(30_000, this.backoff * 2);
		};
		try {
			const disconnect = this.openEvents(frame => {
				if (connected && !signal.aborted) this.frame(frame);
			}, failed);
			if (connected && !signal.aborted) this.disconnect = () => { connected = false; disconnect(); };
			else disconnect();
		} catch { failed(); }
	}

	private frame(frame: BrowserEventFrame): void {
		if (frame.protocol !== "cmux-events" || frame.version !== 1) return;
		const boot = id(frame.boot_id);
		if (!boot) return;
		if (frame.type === "ack") {
			if (this.boot && this.boot !== boot) {
				// A restarted cmux cannot inherit this session's old page ownership.
				for (const binding of [...this.bindings.values()]) this.drop(binding);
				return;
			}
			this.boot = boot;
			this.backoff = 1000;
			// Always reconcile on connection, not just when the replay buffer reports a gap.
			void this.reconcile();
			return;
		}
		if (frame.type !== "event" || boot !== this.boot || !Number.isSafeInteger(frame.seq) || Number(frame.seq) <= this.sequence) return;
		this.sequence = Number(frame.seq);
		const surface = id(frame.surface_id), workspace = id(frame.workspace_id), window = id(frame.window_id);
		for (const binding of [...this.bindings.values()]) {
			const matchingSurface = surface === binding.surfaceId || surface === binding.sourceSurfaceId;
			if ((frame.name === "surface.closed" && matchingSurface)
				|| (frame.name === "workspace.closed" && workspace === binding.workspaceId)
				|| (frame.name === "window.closed" && window === binding.windowId)) {
				this.drop(binding);
			} else if ((frame.name === "surface.moved" && matchingSurface)
				|| (frame.name === "workspace.moved" && workspace === binding.workspaceId)) {
				void this.reconcile();
			}
		}
	}

	private async reconcile(): Promise<void> {
		if (this.checking) { this.dirty = true; return; }
		const signal = this.controller.signal;
		if (signal.aborted) return;
		clearTimeout(this.inventoryRetry);
		this.inventoryRetry = undefined;
		this.checking = true;
		let retryNeeded = false;
		try {
			do {
				retryNeeded = false;
				this.dirty = false;
				for (const binding of [...this.bindings.values()]) {
					try {
						const listing = await execJson(this.pi, ["--json", "--id-format", "both", "rpc", "surface.list", JSON.stringify({
							window_id: binding.windowId, workspace_id: binding.workspaceId,
						})], 4000, signal);
						if (!signal.aborted && !browserTargetPresent(binding, listing)) this.drop(binding);
					} catch (error) {
						if (!signal.aborted && isMissingBrowserWorkspace(error)) this.drop(binding);
						else if (this.bindings.get(binding.surfaceId) === binding) retryNeeded = true;
						// Retry verification failures; a healthy stream will not replay missed closes.
					}
					if (signal.aborted) return;
				}
			} while (this.dirty && !signal.aborted);
		} finally {
			if (this.controller.signal === signal) {
				this.checking = false;
				if (!signal.aborted && this.bindings.size) {
					if (retryNeeded) {
						const retry = setTimeout(() => {
							if (signal.aborted || this.inventoryRetry !== retry) return;
							this.inventoryRetry = undefined;
							void this.reconcile();
						}, this.inventoryBackoff);
						this.inventoryRetry = retry;
						retry.unref();
						this.inventoryBackoff = Math.min(30_000, this.inventoryBackoff * 2);
					} else this.inventoryBackoff = 1000;
				}
			}
		}
	}
}
