import assert from "node:assert/strict";
import { test } from "node:test";
import { openCommandInNewWorkspace } from "../extensions/cmux-core.ts";

const CALLER = { window_ref: "window:1", workspace_ref: "workspace:1", surface_ref: "surface:1" };
const COMMAND = "cd '/project' && exec pi -- 'Review auth'";
const OPTIONS = { title: "Review auth · project" };
const json = (value) => ({ stdout: JSON.stringify(value) });
const commandName = (args) => args[1] === "workspace" ? args.slice(1, 3).join(" ") : args[0] === "--json" ? args[1] : args[0];

function harness(t, options = {}) {
	t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 0; });
	const calls = [];
	let polls = 0;
	return {
		calls,
		pi: {
			async exec(command, args) {
				assert.equal(command, "cmux");
				calls.push(args);
				const subcommand = commandName(args);
				let result;
				switch (subcommand) {
					case "identify": result = options.identify ?? json({ caller: CALLER, focused: { window_ref: "window:99" } }); break;
					case "workspace create": result = options.create ?? json({ workspace_ref: "workspace:2", surface_ref: "surface:2" }); break;
					case "list-panes": {
						assert.equal(args[3], "workspace:2");
						result = options.poll?.(++polls) ?? json({ panes: [{ ref: "pane:2", surface_refs: ["surface:2"] }] });
						break;
					}
					case "respawn-pane": result = options.respawn ?? {}; break;
					case "rename-tab": result = {}; break;
					default: assert.fail(`Unexpected command: ${args.join(" ")}`);
				}
				return { code: 0, killed: false, stdout: "", stderr: "", ...result };
			},
		},
	};
}

function callsFor(h, name) {
	return h.calls.filter((args) => commandName(args) === name);
}

for (const focus of [undefined, true, false]) {
	test(`workspace: use caller window and returned IDs, focus=${focus}`, async (t) => {
		const h = harness(t);
		assert.deepEqual(await openCommandInNewWorkspace(h.pi, "/project", COMMAND, { ...OPTIONS, focus }), { ok: true, workspaceRef: "workspace:2" });
		assert.deepEqual(callsFor(h, "workspace create"), [[
			"--json", "workspace", "create", "--window", "window:1", "--cwd", "/project",
			"--name", OPTIONS.title, "--focus", String(focus ?? true),
		]]);
		assert.deepEqual(callsFor(h, "respawn-pane"), [["respawn-pane", "--workspace", "workspace:2", "--surface", "surface:2", "--command", COMMAND]]);
		assert.deepEqual(callsFor(h, "rename-tab"), [["rename-tab", "--workspace", "workspace:2", "--surface", "surface:2", "--title", OPTIONS.title]]);
		assert.equal(callsFor(h, "list-panes").length, 0);
	});
}

test("workspace: accept UUID-only creation responses", async (t) => {
	const h = harness(t, { create: json({ workspace_id: "new-workspace-uuid", surface_id: "new-surface-uuid" }) });
	assert.deepEqual(await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS), { ok: true, workspaceRef: "new-workspace-uuid" });
	assert.equal(callsFor(h, "respawn-pane")[0][2], "new-workspace-uuid");
	assert.equal(callsFor(h, "respawn-pane")[0][4], "new-surface-uuid");
});

test("workspace: discover a surface only inside the newly returned workspace", async (t) => {
	const h = harness(t, {
		create: json({ workspace_ref: "workspace:2" }),
		poll: (count) => json({ panes: count === 1 ? [] : [{ ref: "pane:2", surface_refs: ["surface:2"] }] }),
	});
	assert.equal((await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS)).ok, true);
	assert.equal(callsFor(h, "list-panes").length, 2);
	assert.equal(callsFor(h, "respawn-pane")[0][2], "workspace:2");
});

for (const identify of [json({}), json({ caller: { ...CALLER, window_ref: undefined } }), json({ caller: { ...CALLER, window_ref: 42 } }), { code: 1, stderr: "not connected" }]) {
	test(`workspace: reject missing caller window: ${JSON.stringify(identify)}`, async (t) => {
		const h = harness(t, { identify });
		assert.equal((await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS)).ok, false);
		assert.equal(h.calls.length, 1);
	});
}

for (const create of [
	{ code: 1, stderr: "unsupported option --name" },
	{ killed: true, stdout: '{"workspace_ref":"workspace:2"}' },
	// Actual legacy CLI output: creation succeeded, but must not be retried.
	{ stdout: "OK workspace:7\n" }, { stdout: "OK" }, json(null), json({ workspace_ref: 42 }),
	json({ workspace_ref: "workspace:1", surface_ref: "surface:1" }),
	json({ workspace_ref: "workspace:2", surface_ref: "surface:1" }),
]) {
	test(`workspace: fail safely without retrying creation: ${JSON.stringify(create)}`, async (t) => {
		const h = harness(t, { create });
		assert.equal((await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS)).ok, false);
		assert.equal(callsFor(h, "workspace create").length, 1);
		assert.equal(h.calls.length, 2, "stop after identify and a single creation attempt");
		assert.equal(callsFor(h, "respawn-pane").length, 0);
		assert.equal(callsFor(h, "rename-tab").length, 0);
	});
}

for (const [label, poll, count] of [
	["ambiguous", () => json({ panes: [{ ref: "pane:2", surface_refs: ["surface:2", "surface:3"] }] }), 1],
	["timeout", () => json({ panes: [] }), 20],
	["failure", () => ({ code: 1, stderr: "unavailable" }), 1],
]) {
	test(`workspace: stop safely on surface discovery ${label}`, async (t) => {
		const h = harness(t, { create: json({ workspace_ref: "workspace:2" }), poll });
		assert.equal((await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS)).ok, false);
		assert.equal(callsFor(h, "list-panes").length, count);
		assert.equal(callsFor(h, "respawn-pane").length, 0);
	});
}

test("workspace: propagate respawn failure without renaming or relaunching", async (t) => {
	const h = harness(t, { respawn: { code: 1, stderr: "respawn failed" } });
	assert.deepEqual(await openCommandInNewWorkspace(h.pi, "/project", COMMAND, OPTIONS), { ok: false, error: "respawn failed" });
	assert.equal(callsFor(h, "respawn-pane").length, 1);
	assert.equal(callsFor(h, "rename-tab").length, 0);
});
