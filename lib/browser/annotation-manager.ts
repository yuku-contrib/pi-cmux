import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AnnotationBridge, type AnnotationConfirmation, type AnnotationTransport } from "./annotations.ts";
import type { BrowserBinding } from "./bindings.ts";
import { confirmAnnotation } from "./annotation-review.ts";

const MAX_BROWSERS = 4;
interface Entry {
	bridge: AnnotationBridge;
	controller: AbortController;
	ready: Promise<void>;
}

/** Per-browser polling and drafts, with at most one confirmation dialog in Pi. */
export class AnnotationManager {
	private entries = new Map<string, Entry>();
	private confirmationTail: Promise<unknown> = Promise.resolve();
	private pi: Pick<ExtensionAPI, "sendUserMessage">;
	private transport: AnnotationTransport;

	constructor(pi: Pick<ExtensionAPI, "sendUserMessage">, transport: AnnotationTransport) {
		this.pi = pi;
		this.transport = transport;
	}

	private confirm: AnnotationConfirmation = (ctx, comment, signal) => {
		const result = this.confirmationTail.catch(() => undefined).then(() => {
			signal.throwIfAborted();
			return confirmAnnotation(ctx, comment, signal);
		});
		this.confirmationTail = result.catch(() => undefined);
		return result;
	};

	start(binding: BrowserBinding, ctx: ExtensionContext, signal?: AbortSignal, waitForPage = false): Promise<void> {
		signal?.throwIfAborted();
		if (!ctx.hasUI) return Promise.reject(new Error("Browser annotations require a confirmation-capable Pi UI"));
		for (const [surface, entry] of this.entries) {
			if (!entry.bridge.active) {
				entry.controller.abort();
				entry.bridge.stop();
				this.entries.delete(surface);
			}
		}
		const existing = this.entries.get(binding.surfaceId);
		if (existing) return existing.ready;
		if (this.entries.size >= MAX_BROWSERS) {
			return Promise.reject(new Error(`Annotation limit: ${MAX_BROWSERS} browsers per Pi session. Stop a bridge before enabling another.`));
		}
		const bridge = new AnnotationBridge(this.pi, this.transport, 1500, this.confirm);
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		const entry: Entry = { bridge, controller, ready: Promise.resolve() };
		this.entries.set(binding.surfaceId, entry);
		entry.ready = bridge.start(binding, ctx, combined, waitForPage).catch(error => {
			if (this.entries.get(binding.surfaceId) === entry) this.entries.delete(binding.surfaceId);
			combined.throwIfAborted();
			throw error;
		});
		return entry.ready;
	}

	/** A closed/moved target needs no page-side disconnect or warning. */
	forget(surfaceId: string): void {
		const entry = this.entries.get(surfaceId);
		if (!entry) return;
		this.entries.delete(surfaceId);
		entry.controller.abort();
		entry.bridge.stop();
	}

	stop(): void {
		for (const entry of this.entries.values()) {
			entry.controller.abort();
			entry.bridge.stop();
		}
		this.entries.clear();
		this.confirmationTail = Promise.resolve();
	}

	async disable(surfaceId?: string): Promise<void> {
		const entries = [...this.entries].filter(([surface]) => !surfaceId || surface === surfaceId);
		for (const [surface, entry] of entries) {
			this.entries.delete(surface);
			entry.controller.abort();
		}
		await Promise.all(entries.map(([, entry]) => entry.bridge.disable()));
	}
}
