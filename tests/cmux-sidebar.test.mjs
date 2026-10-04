import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";
import cmuxSidebarExtension from "../extensions/cmux-sidebar.ts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const MOVED_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SURFACE_ID = "33333333-3333-4333-8333-333333333333";
const PANEL_ID = "44444444-4444-4444-8444-444444444444";
const STATUS_KEY = "pi-cmux-test";
const CLEAR_DELAY_MS = 20;
const ERROR_MESSAGES = [{ role: "assistant", stopReason: "error", errorMessage: "Provider failed" }];

function option(args, name) {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

function createHarness() {
	const handlers = new Map();
	const commands = [];
	const workspaces = new Map();
	const panelId = process.env.CMUX_SURFACE_ID?.trim() || process.env.CMUX_PANEL_ID?.trim();
	const panelOwners = new Map(panelId ? [[panelId, WORKSPACE_ID]] : []);
	const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [] } };

	function statuses(workspace) {
		if (!workspaces.has(workspace)) workspaces.set(workspace, new Map());
		return workspaces.get(workspace);
	}

	cmuxSidebarExtension({
		on(event, handler) { handlers.set(event, handler); },
		async exec(command, args) {
			// cmux follows an explicit panel's owner; without --panel it uses
			// the caller's (possibly stale) CMUX_WORKSPACE_ID.
			const ownerPanel = option(args, "--panel");
			const workspace = ownerPanel ? panelOwners.get(ownerPanel) : process.env.CMUX_WORKSPACE_ID;
			commands.push({ command, args, workspace });
			if (command === "cmux" && workspace) {
				if (args[0] === "set-status") {
					statuses(workspace).set(args[1], { value: args[2], panelId: ownerPanel });
				} else if (args[0] === "clear-status") {
					statuses(workspace).delete(args[1]);
				}
			}
			return { killed: false, code: 0, stdout: "", stderr: "" };
		},
	});

	return {
		commands,
		statuses,
		async emit(event, payload = {}) {
			await handlers.get(event)(payload, ctx);
			await waitForImmediate();
		},
		moveSurface(panel, workspace) {
			const previous = statuses(panelOwners.get(panel));
			for (const [key, entry] of previous) {
				if (entry.panelId !== panel) continue;
				statuses(workspace).set(key, entry);
				previous.delete(key);
			}
			panelOwners.set(panel, workspace);
		},
	};
}

async function withSidebar(overrides, callback) {
	const environment = {
		CMUX_WORKSPACE_ID: WORKSPACE_ID,
		CMUX_SURFACE_ID: SURFACE_ID,
		CMUX_PANEL_ID: "",
		CMUX_TAB_ID: "",
		PI_CMUX_SIDEBAR: "1",
		PI_CMUX_SIDEBAR_STATUS_KEY: STATUS_KEY,
		PI_CMUX_SIDEBAR_FINAL_CLEAR_MS: String(CLEAR_DELAY_MS),
		PI_CMUX_SIDEBAR_PROGRESS: "0",
		PI_CMUX_SIDEBAR_TOKENS: "0",
		PI_CMUX_SIDEBAR_FLASH: "0",
		PI_CMUX_SIDEBAR_LOG_TOOLS: "0",
		...overrides,
	};
	const previous = new Map();
	for (const [name, value] of Object.entries(environment)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	let harness;
	try {
		harness = createHarness();
		await callback(harness);
	} finally {
		try {
			await harness?.emit("session_shutdown");
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}
}

for (const { name, environment, panel } of [
	{
		name: "prefer trimmed surface identity over panel identity",
		environment: { CMUX_SURFACE_ID: ` ${SURFACE_ID} `, CMUX_PANEL_ID: PANEL_ID },
		panel: SURFACE_ID,
	},
	{
		name: "fall back to trimmed panel identity",
		environment: { CMUX_SURFACE_ID: " \t ", CMUX_PANEL_ID: ` ${PANEL_ID} ` },
		panel: PANEL_ID,
	},
	{
		name: "omit panel targeting when no identity is available",
		environment: { CMUX_SURFACE_ID: undefined, CMUX_PANEL_ID: undefined },
		panel: undefined,
	},
]) {
	test(`sidebar statuses and clears ${name}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await withSidebar(environment, async (harness) => {
			await harness.emit("session_start");
			await harness.emit("agent_start");
			await harness.emit("turn_start", { turnIndex: 1 });
			await harness.emit("tool_execution_start", { toolName: "bash", args: {} });
			await harness.emit("tool_execution_end");
			await harness.emit("agent_end", { messages: ERROR_MESSAGES });
			await harness.emit("agent_settled");
			await harness.emit("session_shutdown");

			const panelArgs = panel ? ["--panel", panel] : [];
			const statusCalls = harness.commands.filter(({ args }) => args[0] === "set-status");
			assert.deepEqual(statusCalls.map(({ args }) => args[2]), [
				"Pi running", "Pi turn 2", "Pi bash", "Pi thinking", "Pi error",
			]);
			for (const { args } of statusCalls) {
				assert.equal(option(args, "--panel"), panel);
				assert.deepEqual(args.slice(-(panelArgs.length + 2)), [...panelArgs, "--pid", String(process.pid)]);
			}
			const clearCalls = harness.commands.filter(({ args }) => args[0] === "clear-status");
			assert.equal(clearCalls.length, 2);
			for (const { args } of clearCalls) {
				assert.deepEqual(args, ["clear-status", STATUS_KEY, ...panelArgs]);
			}
		});
	});
}

for (const cleanup of ["final delay", "session_shutdown", "session_start"]) {
	test(`sidebar ${cleanup} clears a surface moved to another workspace`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		await withSidebar({}, async (harness) => {
			await harness.emit("session_start");
			await harness.emit("agent_start");
			assert.equal(harness.statuses(WORKSPACE_ID).get(STATUS_KEY)?.value, "Pi running");

			harness.moveSurface(SURFACE_ID, MOVED_WORKSPACE_ID);
			assert.equal(process.env.CMUX_WORKSPACE_ID, WORKSPACE_ID, "Pi retains its original workspace environment");
			assert.equal(harness.statuses(MOVED_WORKSPACE_ID).get(STATUS_KEY)?.value, "Pi running");
			harness.statuses(WORKSPACE_ID).set(STATUS_KEY, { value: "Unrelated status", panelId: PANEL_ID });

			if (cleanup === "final delay") {
				await harness.emit("agent_end", { messages: ERROR_MESSAGES });
				await harness.emit("agent_settled");
				assert.equal(harness.statuses(MOVED_WORKSPACE_ID).get(STATUS_KEY)?.value, "Pi error");
				t.mock.timers.tick(CLEAR_DELAY_MS);
				await waitForImmediate();
			} else {
				await harness.emit(cleanup);
			}

			assert.equal(harness.statuses(MOVED_WORKSPACE_ID).has(STATUS_KEY), false);
			assert.equal(harness.statuses(WORKSPACE_ID).get(STATUS_KEY)?.value, "Unrelated status");
			const clear = harness.commands.findLast(({ args }) => args[0] === "clear-status");
			assert.equal(clear.workspace, MOVED_WORKSPACE_ID);
			assert.deepEqual(clear.args, ["clear-status", STATUS_KEY, "--panel", SURFACE_ID]);
		});
	});
}
