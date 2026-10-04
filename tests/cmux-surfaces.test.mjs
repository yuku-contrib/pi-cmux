import assert from "node:assert/strict";
import { test } from "node:test";
import { openCommandInNewSplit, openCommandInNewTab } from "../extensions/cmux-core.ts";

const WORKSPACE = "workspace:1";
const PANE = "pane:1";
const CALLER_SURFACE = "surface:1";
const CREATED_SURFACE = "surface:2";
const CREATED_UUID = "d5205889-944b-4447-a8e9-7a46f120d7f3";
const COMMAND = "exec pi -- '--help'";
const TITLE = "Pi · project";
const BEFORE = [{ ref: PANE, selected_surface_ref: CALLER_SURFACE, surface_refs: [CALLER_SURFACE] }];

const workflows = [
	{
		name: "split",
		createCommand: "new-split",
		open: (pi, options) => openCommandInNewSplit(pi, "right", COMMAND, options),
		createArgs: ["--json", "new-split", "right", "--workspace", WORKSPACE, "--surface", CALLER_SURFACE],
		after: [...BEFORE, { ref: "pane:2", selected_surface_ref: CREATED_SURFACE, surface_refs: [CREATED_SURFACE] }],
	},
	{
		name: "tab",
		createCommand: "new-surface",
		open: (pi, options) => openCommandInNewTab(pi, COMMAND, options),
		createArgs: ["--json", "new-surface", "--type", "terminal", "--workspace", WORKSPACE, "--pane", PANE, "--focus", "true"],
		after: [{ ref: PANE, selected_surface_ref: CREATED_SURFACE, surface_refs: [CALLER_SURFACE, CREATED_SURFACE] }],
	},
];

function jsonResult(value) {
	return { stdout: JSON.stringify(value) };
}

function createHarness(t, workflow, options = {}) {
	// Exercise the real helpers with a stub CLI and no real boot/poll waits.
	const delays = [];
	t.mock.method(globalThis, "setTimeout", (callback, ms) => {
		delays.push(ms);
		queueMicrotask(callback);
		return 0;
	});
	const calls = [];
	let paneReadCount = 0;
	const pi = {
		async exec(command, args) {
			assert.equal(command, "cmux");
			calls.push(args);
			const subcommand = args[0] === "--json" ? args[1] : args[0];
			let result;
			switch (subcommand) {
				case "identify":
					result = jsonResult({ caller: { workspace_ref: WORKSPACE, pane_ref: PANE, surface_ref: CALLER_SURFACE } });
					break;
				case "list-panes": {
					const index = paneReadCount++;
					result = index === 0
						? options.beforeResult ?? jsonResult({ panes: BEFORE })
						: options.pollResult?.(index) ?? jsonResult({ panes: workflow.after });
					break;
				}
				case workflow.createCommand:
					result = typeof options.createResult === "function"
						? await options.createResult()
						: options.createResult ?? jsonResult({ surface_ref: CREATED_SURFACE });
					break;
				case "respawn-pane":
					result = options.respawnResult ?? {};
					break;
				case "rename-tab":
					result = {};
					break;
				default:
					assert.fail(`Unexpected cmux command: ${args.join(" ")}`);
			}
			return { code: 0, killed: false, stdout: "", stderr: "", ...result };
		},
	};
	return {
		pi,
		delays,
		callsFor: (command) => calls.filter((args) => (args[0] === "--json" ? args[1] : args[0]) === command),
		get paneReadCount() { return paneReadCount; },
	};
}

function assertTarget(harness, surface) {
	assert.deepEqual(harness.callsFor("respawn-pane"), [
		["respawn-pane", "--workspace", WORKSPACE, "--surface", surface, "--command", COMMAND],
	]);
	assert.deepEqual(harness.callsFor("rename-tab"), [
		["rename-tab", "--workspace", WORKSPACE, "--surface", surface, "--title", TITLE],
	]);
}

function assertNoLaunch(harness) {
	assert.deepEqual(harness.callsFor("respawn-pane"), []);
	assert.deepEqual(harness.callsFor("rename-tab"), []);
}

for (const workflow of workflows) {
	for (const [label, response, expected] of [
		["surface_ref", { surface_ref: CREATED_SURFACE }, CREATED_SURFACE],
		["surface_id", { surface_id: CREATED_UUID }, CREATED_UUID],
		["ref preferred over UUID", { surface_ref: CREATED_SURFACE, surface_id: CREATED_UUID }, CREATED_SURFACE],
		["invalid ref with valid UUID", { surface_ref: 42, surface_id: CREATED_UUID }, CREATED_UUID],
		["blank ref with padded UUID", { surface_ref: "  ", surface_id: ` ${CREATED_UUID}\n` }, CREATED_UUID],
	]) {
		test(`${workflow.name}: use returned ${label} without discovery polling`, async (t) => {
			const harness = createHarness(t, workflow, {
				createResult: jsonResult(response),
				// A concurrent creation would fool the old first-new-surface polling.
				pollResult: () => jsonResult({ panes: [
					...BEFORE,
					{ ref: "pane:99", selected_surface_ref: "surface:99", surface_refs: ["surface:99"] },
					...workflow.after,
				] }),
			});
			assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: true });
			assert.deepEqual(harness.callsFor(workflow.createCommand), [workflow.createArgs]);
			assert.equal(harness.paneReadCount, 1, "only the legacy compatibility snapshot is needed");
			assert.deepEqual(harness.delays, [250], "keep the existing surface boot delay, but do not poll");
			assertTarget(harness, expected);
		});
	}

	test(`${workflow.name}: simultaneous launches use their own returned surfaces`, async (t) => {
		const surfaces = [CREATED_SURFACE, "surface:3"];
		let created = 0;
		const harness = createHarness(t, workflow, {
			createResult: () => jsonResult({ surface_ref: surfaces[created++] }),
			pollResult: () => jsonResult({ panes: BEFORE }),
		});
		const results = await Promise.all(surfaces.map((_surface, index) =>
			workflow.open(harness.pi, { tabTitle: `Job ${index + 1}` })));
		assert.deepEqual(results, [{ ok: true }, { ok: true }]);
		assert.equal(harness.paneReadCount, 2, "one compatibility snapshot per launch, no discovery polling");
		assert.deepEqual(harness.callsFor("respawn-pane").map((args) => args[4]), surfaces);
		assert.deepEqual(harness.callsFor("rename-tab").map((args) => [args[4], args[6]]), [
			[CREATED_SURFACE, "Job 1"], ["surface:3", "Job 2"],
		]);
	});

	test(`${workflow.name}: a failed compatibility snapshot does not block a returned ID`, async (t) => {
		const harness = createHarness(t, workflow, { beforeResult: { code: 1, stderr: "pane listing unavailable" } });
		assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: true });
		assert.equal(harness.paneReadCount, 1);
		assertTarget(harness, CREATED_SURFACE);
	});

	for (const stdout of ["OK", "", "null", "{}", '{"pane_ref":"pane:2"}', '{"surface_ref":42,"surface_id":false}', '{"surface_ref":"  ","surface_id":""}']) {
		test(`${workflow.name}: fall back once creation succeeds without an ID: ${JSON.stringify(stdout)}`, async (t) => {
			const harness = createHarness(t, workflow, { createResult: { stdout } });
			assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: true });
			assert.equal(harness.callsFor(workflow.createCommand).length, 1, "never create a second surface to retry output parsing");
			assert.equal(harness.paneReadCount, 2);
			assertTarget(harness, CREATED_SURFACE);
		});
	}

	for (const [label, createResult, error] of [
		["failure", { code: 1, stderr: "creation failed" }, "creation failed"],
		["timeout", { killed: true, stdout: JSON.stringify({ surface_ref: CREATED_SURFACE }) }, "cmux command timed out"],
	]) {
		test(`${workflow.name}: do not discover or launch after creation ${label}`, async (t) => {
			const harness = createHarness(t, workflow, { createResult });
			assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: false, error });
			assert.equal(harness.callsFor(workflow.createCommand).length, 1);
			assert.equal(harness.paneReadCount, 1);
			assertNoLaunch(harness);
		});
	}

	test(`${workflow.name}: do not fall back to another surface when respawn fails`, async (t) => {
		const harness = createHarness(t, workflow, { respawnResult: { code: 1, stderr: "respawn failed" } });
		assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: false, error: "respawn failed" });
		assert.equal(harness.callsFor(workflow.createCommand).length, 1);
		assert.equal(harness.paneReadCount, 1);
		assert.equal(harness.callsFor("respawn-pane")[0][4], CREATED_SURFACE);
		assert.deepEqual(harness.callsFor("rename-tab"), []);
	});

	for (const beforeResult of [
		{ code: 1, stderr: "pane listing unavailable" },
		{ stdout: "invalid JSON" },
		jsonResult({}),
		jsonResult({ panes: {} }),
		jsonResult({ panes: [null] }),
	]) {
		test(`${workflow.name}: refuse discovery without a valid pre-creation snapshot: ${JSON.stringify(beforeResult)}`, async (t) => {
			const harness = createHarness(t, workflow, { beforeResult, createResult: { stdout: "OK" } });
			const result = await workflow.open(harness.pi, { tabTitle: TITLE });
			assert.equal(result.ok, false);
			assert.match(result.error, /Created (split|tab), but/);
			assert.equal(harness.callsFor(workflow.createCommand).length, 1);
			assert.equal(harness.paneReadCount, 1);
			assertNoLaunch(harness);
		});
	}

	test(`${workflow.name}: stop discovery on a pane listing failure`, async (t) => {
		const harness = createHarness(t, workflow, {
			createResult: { stdout: "OK" },
			pollResult: () => ({ code: 1, stderr: "pane listing unavailable" }),
		});
		assert.equal((await workflow.open(harness.pi, { tabTitle: TITLE })).ok, false);
		assert.equal(harness.paneReadCount, 2);
		assertNoLaunch(harness);
	});

	test(`${workflow.name}: bound discovery when no new surface appears`, async (t) => {
		const harness = createHarness(t, workflow, {
			createResult: { stdout: "OK" },
			pollResult: () => jsonResult({ panes: BEFORE }),
		});
		assert.equal((await workflow.open(harness.pi, { tabTitle: TITLE })).ok, false);
		assert.equal(harness.paneReadCount, 21);
		assert.equal(harness.callsFor(workflow.createCommand).length, 1);
		assertNoLaunch(harness);
	});

	test(`${workflow.name}: reject ambiguous legacy discovery`, async (t) => {
		const panes = structuredClone(workflow.after);
		panes.at(-1).surface_refs.push("surface:3");
		const harness = createHarness(t, workflow, {
			createResult: { stdout: "OK" },
			pollResult: () => jsonResult({ panes }),
		});
		assert.equal((await workflow.open(harness.pi, { tabTitle: TITLE })).ok, false);
		assertNoLaunch(harness);
	});

	test(`${workflow.name}: preserve explicit focus=false`, async (t) => {
		const harness = createHarness(t, workflow);
		assert.deepEqual(await workflow.open(harness.pi, { focus: false }), { ok: true });
		const args = harness.callsFor(workflow.createCommand)[0];
		assert.equal(args[args.indexOf("--focus") + 1], "false");
	});
}

test("legacy tab discovery ignores surfaces created in other panes", async (t) => {
	const workflow = workflows[1];
	const unrelated = { ref: "pane:99", selected_surface_ref: "surface:99", surface_refs: ["surface:99"] };
	const harness = createHarness(t, workflow, {
		createResult: { stdout: "OK" },
		pollResult: (index) => jsonResult({ panes: [...(index === 1 ? BEFORE : workflow.after), unrelated] }),
	});
	assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: true });
	assert.equal(harness.paneReadCount, 3);
	assertTarget(harness, CREATED_SURFACE);
});

test("legacy split discovery ignores new tabs in existing panes", async (t) => {
	const workflow = workflows[0];
	const unrelated = { ref: PANE, selected_surface_ref: "surface:99", surface_refs: [CALLER_SURFACE, "surface:99"] };
	const harness = createHarness(t, workflow, {
		createResult: { stdout: "OK" },
		pollResult: (index) => jsonResult({ panes: index === 1 ? [unrelated] : [unrelated, workflow.after[1]] }),
	});
	assert.deepEqual(await workflow.open(harness.pi, { tabTitle: TITLE }), { ok: true });
	assert.equal(harness.paneReadCount, 3);
	assertTarget(harness, CREATED_SURFACE);
});

test("legacy split discovery rejects multiple new panes even if only one has a ready surface", async (t) => {
	const workflow = workflows[0];
	const harness = createHarness(t, workflow, {
		createResult: { stdout: "OK" },
		pollResult: () => jsonResult({ panes: [...workflow.after, { ref: "pane:3", surface_refs: [] }] }),
	});
	assert.equal((await workflow.open(harness.pi, { tabTitle: TITLE })).ok, false);
	assertNoLaunch(harness);
});

test("preserve downward split placement and explicit focus=true", async (t) => {
	const harness = createHarness(t, workflows[0]);
	assert.deepEqual(await openCommandInNewSplit(harness.pi, "down", COMMAND, { focus: true }), { ok: true });
	assert.deepEqual(harness.callsFor("new-split"), [
		["--json", "new-split", "down", "--workspace", WORKSPACE, "--surface", CALLER_SURFACE, "--focus", "true"],
	]);
});
