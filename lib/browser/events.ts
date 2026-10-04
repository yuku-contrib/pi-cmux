import { spawn } from "node:child_process";

export type BrowserEventFrame = Record<string, unknown>;
export type OpenBrowserEvents = (frame: (value: BrowserEventFrame) => void, disconnected: () => void) => () => void;
const NAMES = ["surface.closed", "workspace.closed", "window.closed", "surface.moved", "workspace.moved"];

/** One bounded JSONL reader. No shell, cursor file, or page-side operations. */
export function openBrowserEvents(
	onFrame: (value: BrowserEventFrame) => void,
	onDisconnected: () => void,
	spawnProcess: typeof spawn = spawn,
): () => void {
	const child = spawnProcess("cmux", ["events", ...NAMES.flatMap(name => ["--name", name])], { stdio: ["ignore", "pipe", "pipe"] });
	let stopped = false;
	let buffer = "";
	let watchdog: ReturnType<typeof setTimeout>;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		clearTimeout(watchdog);
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.kill();
		if (child.exitCode === null && child.signalCode === null) {
			const kill = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 1000);
			kill.unref();
		}
	};
	const fail = () => { if (!stopped) { stop(); onDisconnected(); } };
	const heartbeat = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(fail, 45_000);
		watchdog.unref();
	};
	child.on("error", fail);
	child.on("close", fail);
	child.stdout?.on("error", fail);
	child.stderr?.on("error", fail);
	child.stderr?.resume(); // Drain without retaining output or leaking it into Pi's terminal.
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		if (stopped) return;
		buffer += chunk;
		let end: number;
		while ((end = buffer.indexOf("\n")) !== -1) {
			if (end > 65_536) { fail(); return; }
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const frame: unknown = JSON.parse(line);
				if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid event frame");
				const value = frame as BrowserEventFrame;
				if (value.protocol !== "cmux-events" || value.version !== 1 || !["ack", "event", "heartbeat"].includes(String(value.type))) {
					throw new Error("Unsupported event stream");
				}
				heartbeat();
				onFrame(value);
				if (stopped) return;
			} catch { fail(); return; }
		}
		if (buffer.length > 65_536) fail();
	});
	heartbeat();
	return stop;
}
