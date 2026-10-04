import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildPiCommand, buildShellCommand, openCommandInNewWorkspace } from "../extensions/cmux-core.ts";

// Opt in with an absolute CLI path. Default CI never needs cmux or a running app.
const cli = process.env.PI_CMUX_TEST_CLI;
const contract = { skip: !cli && "Set PI_CMUX_TEST_CLI to an installed cmux executable", timeout: 30_000 };
const execute = promisify(execFile);
// Synthetic data only. No live identify, config, socket, or captured session fixtures.
const WINDOW = "11111111-1111-4111-8111-111111111111";
const SOURCE_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SOURCE_SURFACE = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const SURFACE = "55555555-5555-4555-8555-555555555555";
const OTHER_WINDOW = "99999999-9999-4999-8999-999999999999";
const CALLER = {
	window_id: WINDOW, window_ref: "window:1",
	workspace_id: SOURCE_WORKSPACE, workspace_ref: "workspace:1",
	surface_id: SOURCE_SURFACE, surface_ref: "surface:1",
};
const CREATED = {
	window_id: WINDOW, window_ref: "window:1",
	workspace_id: WORKSPACE, workspace_ref: "workspace:7",
	surface_id: SURFACE, surface_ref: "surface:27",
};
const CWD = "/tmp/pi-cmux-contract-project";
const TITLE = "Contract 'title' · project";

async function fakeCli(t, options = {}) {
	assert.ok(isAbsolute(cli), "PI_CMUX_TEST_CLI must be an absolute executable path");
	// Keep the Unix socket path short even on macOS. HOME is isolated too.
	const root = await mkdtemp("/tmp/pc-contract-");
	const socketPath = join(root, "socket");
	const requests = [];
	const calls = [];
	const failures = [];
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", (error) => failures.push(error.message));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				let request;
				try {
					request = JSON.parse(line);
					requests.push(request);
					let result;
					switch (request.method) {
						case "system.identify": result = { caller: CALLER, focused: { window_id: OTHER_WINDOW, window_ref: "window:99" } }; break;
						case "window.list": result = { windows: [{ id: OTHER_WINDOW, ref: "window:99" }, { id: WINDOW, ref: "window:1" }] }; break;
						case "workspace.list":
							assert.ok([WINDOW, OTHER_WINDOW].includes(request.params.window_id));
							result = { workspaces: request.params.window_id === WINDOW
								? [{ id: SOURCE_WORKSPACE, ref: "workspace:1" }, { id: WORKSPACE, ref: "workspace:7" }]
								: [] };
							break;
						case "surface.list":
							assert.equal(request.params.workspace_id, WORKSPACE);
							result = { surfaces: [{ id: SURFACE, ref: "surface:27" }] };
							break;
						case "workspace.create":
							if (options.rejectCreate) {
								socket.write(JSON.stringify({ id: request.id, ok: false, error: { code: "contract_rejected", message: "creation rejected" } }) + "\n");
								continue;
							}
							result = options.created ?? CREATED;
							break;
						case "surface.respawn":
						case "tab.action": result = CREATED; break;
						default: throw new Error(`Unexpected method: ${request.method}`);
					}
					socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
				} catch (error) {
					failures.push(error.message);
					socket.write(JSON.stringify({ id: request?.id, ok: false, error: { code: "unexpected_request", message: error.message } }) + "\n");
				}
			}
		});
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
		assert.deepEqual(failures, [], "fake socket must recognize every request");
	});
	server.listen(socketPath);
	await once(server, "listening");
	const pi = {
		async exec(command, args, options = {}) {
			assert.equal(command, "cmux");
			// Every invocation is pinned to our socket; never fall back to the app.
			const cliArgs = ["--socket", socketPath, ...args];
			let result;
			try {
				result = { ...await execute(cli, cliArgs, {
					encoding: "utf8", timeout: options.timeout ?? 5000,
					env: {
						PATH: "/usr/bin:/bin", HOME: root, CMUX_SOCKET_PATH: socketPath,
						CMUX_WORKSPACE_ID: SOURCE_WORKSPACE, CMUX_SURFACE_ID: SOURCE_SURFACE,
						CMUX_PANEL_ID: SOURCE_SURFACE, CMUX_QUIET: "1",
					},
				}), code: 0, killed: false };
			} catch (error) {
				// A missing/unlaunchable CLI is a test setup failure, not a cmux error.
				if (typeof error.code !== "number") throw error;
				result = { code: error.code, killed: Boolean(error.killed), stdout: error.stdout, stderr: error.stderr };
			}
			calls.push({ args, ...result });
			return result;
		},
	};
	return { pi, requests, calls, requestsFor: (method) => requests.filter((request) => request.method === method) };
}

for (const focus of [undefined, true, false]) {
	test(`installed cmux: workspace launch targets returned IDs, focus=${focus}`, contract, async (t) => {
		const h = await fakeCli(t);
		let command;
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = "/contract/bin:/usr/bin:/bin";
			command = focus === false
				? buildShellCommand(CWD, "printf '%s' 'contract only; never executed'")
				: buildPiCommand(CWD, { prompt: "Contract 'prompt'; $HOME" });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		assert.deepEqual(await openCommandInNewWorkspace(h.pi, CWD, command, { title: TITLE, focus }), { ok: true, workspaceRef: "workspace:7" });
		assert.deepEqual(h.calls.map(({ args }) => args.slice(0, args[0] === "--json" ? 3 : 1)), [
			["--json", "identify"], ["--json", "workspace", "create"], ["respawn-pane"], ["rename-tab"],
		]);
		assert.deepEqual(h.requestsFor("workspace.create").map(({ params }) => params), [{
			window_id: WINDOW, cwd: CWD, title: TITLE, focus: focus ?? true,
		}]); // No command/initial_input during creation.
		const respawns = h.requestsFor("surface.respawn");
		assert.equal(respawns.length, 1);
		assert.equal(respawns[0].params.workspace_id, WORKSPACE);
		assert.equal(respawns[0].params.surface_id, SURFACE);
		assert.equal(respawns[0].params.tmux_start_command, command);
		// cmux 0.64.25 adds this outer LOGIN shell. Do not execute it in this test.
		assert.equal(respawns[0].params.command, `/bin/sh -lc '${command.replaceAll("'", `'"'"'`)}'`);
		const renames = h.requestsFor("tab.action");
		assert.equal(renames.length, 1);
		// rename-tab forwards refs to the server rather than resolving UUIDs.
		assert.equal(renames[0].params.workspace_id, "workspace:7");
		assert.equal(renames[0].params.surface_id, "surface:27");
		assert.equal(renames[0].params.action, "rename");
		assert.equal(renames[0].params.title, TITLE);
	});
}

// Locks down the observed CLI distinction that a JSON-returning mock concealed.
test("installed cmux: legacy new-workspace ignores --json, workspace create honors it", contract, async (t) => {
	const h = await fakeCli(t);
	const flags = ["--window", "window:1", "--cwd", CWD, "--name", TITLE, "--focus", "false"];
	const legacy = await h.pi.exec("cmux", ["--json", "new-workspace", ...flags]);
	const structured = await h.pi.exec("cmux", ["--json", "workspace", "create", ...flags]);
	assert.equal(legacy.code, 0, legacy.stderr);
	assert.equal(legacy.stdout, "OK workspace:7\n");
	assert.equal(structured.code, 0, structured.stderr);
	assert.deepEqual(JSON.parse(structured.stdout), { window_ref: "window:1", workspace_ref: "workspace:7", surface_ref: "surface:27" });
	const creates = h.requestsFor("workspace.create");
	assert.equal(creates.length, 2); // Two explicit probes, not a launch retry.
	assert.deepEqual(creates[0].params, creates[1].params);
});

for (const [label, options] of [["rejected", { rejectCreate: true }], ["missing IDs", { created: {} }]]) {
	test(`installed cmux: ${label} creation is never retried or launched`, contract, async (t) => {
		const h = await fakeCli(t, options);
		const result = await openCommandInNewWorkspace(h.pi, CWD, "NOT EXECUTED", { title: TITLE });
		assert.equal(result.ok, false);
		assert.match(result.error, options.rejectCreate ? /creation rejected/ : /could not identify the new cmux workspace safely/);
		assert.equal(h.requestsFor("workspace.create").length, 1);
		assert.equal(h.calls.length, 2);
		assert.equal(h.requestsFor("surface.respawn").length, 0);
		assert.equal(h.requestsFor("tab.action").length, 0);
	});
}
