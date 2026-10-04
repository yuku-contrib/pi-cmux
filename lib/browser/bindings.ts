import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openBrowserSplit, type BrowserOpenOptions, type OpenedBrowser } from "./client.ts";

export type BrowserBinding = Readonly<OpenedBrowser & { sessionId: string }>;

interface BrowserSession {
	id: string;
	controller: AbortController;
	bindings: Map<string, BrowserBinding>;
}

/** Runtime-only bindings. Existing browser panes survive Pi shutdown/reload/session replacement. */
export class BrowserBindings {
	private session?: BrowserSession;

	start(sessionId: string): void {
		this.stop();
		this.session = { id: sessionId, controller: new AbortController(), bindings: new Map() };
	}

	stop(): void {
		const previous = this.session;
		this.session = undefined;
		previous?.controller.abort(new Error("Pi browser session ended"));
		previous?.bindings.clear();
	}

	list(sessionId: string): BrowserBinding[] {
		return this.session?.id === sessionId ? [...this.session.bindings.values()] : [];
	}

	remove(binding: BrowserBinding): boolean {
		if (this.session?.id !== binding.sessionId || this.session.bindings.get(binding.surfaceId) !== binding) return false;
		return this.session.bindings.delete(binding.surfaceId);
	}

	async open(
		pi: Pick<ExtensionAPI, "exec">,
		sessionId: string,
		options: BrowserOpenOptions,
		signal?: AbortSignal,
	): Promise<BrowserBinding> {
		const session = this.session;
		if (!session || session.id !== sessionId) throw new Error("Browser session is not active; reload Pi before opening a browser");
		const combinedSignal = signal
			? AbortSignal.any([session.controller.signal, signal])
			: session.controller.signal;
		const opened = await openBrowserSplit(pi, options, combinedSignal);
		if (combinedSignal.aborted || this.session !== session) {
			throw new Error(`Browser ${opened.surfaceId} was opened but not bound because the operation ended or Pi session changed. The browser remains open.`);
		}
		if (session.bindings.has(opened.surfaceId)) {
			throw new Error("cmux returned an already-bound browser surface; refusing to replace its binding");
		}
		const binding: BrowserBinding = Object.freeze({ ...opened, sessionId });
		session.bindings.set(binding.surfaceId, binding);
		return binding;
	}
}
