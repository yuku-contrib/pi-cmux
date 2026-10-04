import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { BrowserLifecycle } from "../lib/browser/lifecycle.ts";
import { openBrowserEvents } from "../lib/browser/events.ts";
import { browserTargetPresent, isMissingBrowserWorkspace } from "../lib/browser/targets.ts";
import { CmuxAnnotationTransport } from "../lib/browser/transport.ts";

const W = "11111111-1111-4111-8111-111111111111", WS = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333", PANE = "44444444-4444-4444-8444-444444444444";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOOT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const binding = surfaceId => ({ sessionId: "one", windowId: W, workspaceId: WS, sourceSurfaceId: SOURCE, paneId: PANE, surfaceId, url: "https://example.test/", placement: "right", focus: false });
const inventory = (...ids) => ({ window_id: W, workspace_id: WS, surfaces: [
	{ id: SOURCE, type: "terminal" }, ...ids.map(id => ({ id, type: "browser", pane_id: PANE })),
] });
const frame = (type, extra = {}) => ({ type, protocol: "cmux-events", version: 1, boot_id: BOOT, ...extra });
const flush = async () => { await immediate(); await immediate(); };
const result = value => ({ code: 0, killed: false, stdout: JSON.stringify(value), stderr: "" });
function harness(t) {
	const removed = [], connections = [], calls = [];
	const state = { listing: inventory(A, B), response: undefined };
	const pi = { async exec(cmd, args, opts) {
		calls.push({ cmd, args, opts });
		assert.equal(cmd, "cmux"); assert.equal(args[4], "surface.list");
		assert.deepEqual(JSON.parse(args[5]), { window_id: W, workspace_id: WS });
		assert.equal(opts.timeout, 4000);
		return state.response ? state.response(opts) : result(state.listing);
	} };
	const lifecycle = new BrowserLifecycle(pi, target => removed.push(target), (onFrame, disconnected) => {
		const connection = { onFrame, disconnected, stopped: false };
		connections.push(connection);
		return () => { connection.stopped = true; };
	});
	t.after(() => lifecycle.stop());
	let seq = 0;
	return { lifecycle, pi, state, removed, connections, calls,
		ack: (extra = {}, index = connections.length - 1) => connections[index].onFrame(frame("ack", extra)),
		event: (name, extra = {}, index = connections.length - 1) => connections[index].onFrame(frame("event", { seq: ++seq, name, ...extra })),
	};
}

function timerHarness(t) {
	const pending = new Set();
	t.mock.method(globalThis, "setTimeout", (callback, ms) => {
		const job = { callback, ms, unreferenced: false, unref() { this.unreferenced = true; } };
		pending.add(job);
		return job;
	});
	t.mock.method(globalThis, "clearTimeout", job => { pending.delete(job); });
	return { pending, async run(ms) {
		assert.equal(pending.size, 1, "only one retry may be scheduled");
		const [job] = pending;
		assert.equal(job.ms, ms);
		assert.equal(job.unreferenced, true, "retry must not hold Pi open");
		pending.delete(job);
		job.callback();
		await flush();
	} };
}

test("listener is lazy, shared across browsers, UUID-targeted, and quiet on close", async t => {
	const h = harness(t), a = binding(A), b = binding(B);
	assert.equal(h.connections.length, 0);
	h.lifecycle.track(a); h.lifecycle.track(b); h.ack(); await flush();
	assert.equal(h.connections.length, 1);
	h.event("surface.closed", { surface_id: A.toUpperCase() });
	assert.deepEqual(h.removed, [a]); assert.equal(h.connections[0].stopped, false);
	h.event("surface.closed", { surface_id: A });
	assert.deepEqual(h.removed, [a]);
	h.event("surface.closed", { surface_id: B });
	assert.deepEqual(h.removed, [a, b]); assert.equal(h.connections[0].stopped, true);
});

for (const [name, fields] of [["surface.closed", {surface_id: SOURCE}], ["workspace.closed", {workspace_id: WS}], ["window.closed", {window_id: W}]]) {
	test(`${name} for the owner clears all affected browser bindings`, async t => {
		const h = harness(t); h.lifecycle.track(binding(A)); h.lifecycle.track(binding(B)); h.ack(); await flush();
		h.event(name, fields); assert.equal(h.removed.length, 2); assert.equal(h.connections[0].stopped, true);
	});
}

test("unrelated IDs, short refs, unacknowledged and wrong-boot events cannot remove bindings", async t => {
	const h = harness(t); h.lifecycle.track(binding(A)); await flush();
	h.event("surface.closed", {surface_id: A});
	h.ack();
	h.event("surface.closed", {surface_id: B});
	h.event("surface.closed", {surface_id: "surface:1"});
	h.event("surface.closed", {surface_id: A, boot_id: B});
	assert.deepEqual(h.removed, []);
});

test("initial inventory covers closure before subscription and missing source terminals", async t => {
	for (const listing of [inventory(), {window_id: W, workspace_id: WS, surfaces: [{id: A, type:"browser", pane_id:PANE}]}]) {
		const h = harness(t); h.state.listing = listing; h.lifecycle.track(binding(A)); await flush();
		assert.equal(h.removed.length, 1); assert.equal(h.connections[0].stopped, true);
	}
});

test("moved surfaces are rechecked, never adopted into replacement panes", async t => {
	const h = harness(t), a = binding(A); h.lifecycle.track(a); h.ack(); await flush();
	h.event("surface.moved", {surface_id: SOURCE}); await flush();
	assert.equal(h.removed.length, 0, "moving source within the same workspace remains valid");
	h.state.listing.surfaces[1].pane_id = B;
	h.event("surface.moved", {surface_id: A}); await flush();
	assert.deepEqual(h.removed, [a]);
});

test("reconnect reconciles missed closes even without a reported replay gap", async t => {
	const jobs = [];
	t.mock.method(globalThis, "setTimeout", (callback, ms) => { const job = {callback, ms, unref(){}}; jobs.push(job); return job; });
	t.mock.method(globalThis, "clearTimeout", () => {});
	const h = harness(t), a = binding(A); h.lifecycle.track(a); h.ack(); await flush();
	h.connections[0].disconnected(); assert.equal(jobs[0].ms, 1000);
	h.state.listing = inventory(); jobs.shift().callback();
	assert.equal(h.connections.length, 2);
	h.ack({resume: {gap:false}}); await flush();
	assert.deepEqual(h.removed, [a]);
});

test("event connection failures back off and shutdown prevents reconnect", async t => {
	const jobs = [];
	t.mock.method(globalThis, "setTimeout", (callback, ms) => { const job = {callback, ms, unref(){}}; jobs.push(job); return job; });
	t.mock.method(globalThis, "clearTimeout", () => {});
	const h = harness(t); h.lifecycle.track(binding(A)); await flush();
	for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
		h.connections.at(-1).disconnected(); const job = jobs.shift(); assert.equal(job.ms, ms); job.callback();
	}
	h.connections.at(-1).disconnected(); h.lifecycle.stop(); const count = h.connections.length;
	jobs.shift().callback(); assert.equal(h.connections.length, count);
});

for (const phase of ["initial", "reconnect", "move"]) {
	for (const response of [result({}), {code:0, killed:true, stdout:"", stderr:""}]) {
		test(`${phase} inventory failure retries despite healthy heartbeats: ${JSON.stringify(response)}`, async t => {
			const timers = timerHarness(t), h = harness(t), a = binding(A);
			if (phase === "initial") h.state.response = () => response;
			h.lifecycle.track(a); h.ack(); await flush();
			if (phase !== "initial") {
				h.state.response = () => response;
				if (phase === "reconnect") {
					h.connections[0].disconnected(); await timers.run(1000);
					h.ack();
				} else h.event("surface.moved", {surface_id: A});
				await flush();
			}
			assert.deepEqual(h.removed, [], "failure alone is not closure");
			for (let i = 0; i < 20; i++) h.connections.at(-1).onFrame(frame("heartbeat"));
			h.state.response = undefined;
			h.state.listing = inventory();
			await timers.run(1000);
			assert.deepEqual(h.removed, [a]);
			assert.equal(h.connections.at(-1).stopped, true);
			assert.equal(timers.pending.size, 0);
		});
	}
}

test("inventory retries back off independently and reset after successful verification", async t => {
	const timers = timerHarness(t), h = harness(t);
	h.state.response = () => result({});
	h.lifecycle.track(binding(A)); h.ack(); await flush();
	for (const ms of [1000, 2000, 4000, 8000, 16000, 30000]) await timers.run(ms);
	h.state.response = undefined;
	await timers.run(30000);
	assert.equal(timers.pending.size, 0, "successful inventory does not keep polling");
	assert.equal(h.connections.length, 1, "inventory retries do not reconnect the event stream");
	h.state.response = () => result({});
	h.event("surface.moved", {surface_id: A}); await flush();
	await timers.run(1000);
});

for (const stop of ["shutdown", "last binding removed"]) {
	test(`${stop} cancels inventory retry and stale callbacks cannot affect a replacement session`, async t => {
		const timers = timerHarness(t), h = harness(t), a = binding(A);
		h.state.response = () => result({});
		h.lifecycle.track(a); h.ack(); await flush();
		const [oldRetry] = timers.pending;
		if (stop === "shutdown") h.lifecycle.stop();
		else h.lifecycle.forget(a);
		assert.equal(timers.pending.size, 0);
		const next = {...a, sessionId:"two"};
		h.lifecycle.track(next); h.ack(); await flush();
		const [nextRetry] = timers.pending, count = h.calls.length;
		oldRetry.callback(); await flush();
		assert.equal(h.calls.length, count);
		assert.deepEqual([...timers.pending], [nextRetry]);
		h.state.response = undefined; h.state.listing = inventory();
		await timers.run(1000);
		assert.deepEqual(h.removed, [next]);
	});
}

test("successful event reconciliation cancels an older inventory retry", async t => {
	const timers = timerHarness(t), h = harness(t);
	h.state.response = () => result({});
	h.lifecycle.track(binding(A)); h.ack(); await flush();
	const [oldRetry] = timers.pending;
	h.state.response = undefined;
	h.event("surface.moved", {surface_id: A}); await flush();
	assert.equal(timers.pending.size, 0);
	const count = h.calls.length;
	oldRetry.callback(); await flush();
	assert.equal(h.calls.length, count);
});

test("cmux restart invalidates bindings even if UUIDs were restored", async t => {
	const h = harness(t); h.lifecycle.track(binding(A)); h.ack(); await flush();
	h.ack({boot_id: B}); assert.equal(h.removed.length, 1);
});

test("session stop ignores late events and late inventory results", async t => {
	const h = harness(t); let resolve;
	h.state.response = () => new Promise(done => {resolve = done;});
	h.lifecycle.track(binding(A)); h.ack(); h.lifecycle.stop();
	h.state.response = undefined; const next = {...binding(A), sessionId:"two"}; h.lifecycle.track(next); h.ack(); await flush();
	h.event("surface.closed", {surface_id:A}, 0); resolve(result(inventory())); await flush();
	assert.deepEqual(h.removed, []);
	h.event("surface.closed", {surface_id:A}); assert.deepEqual(h.removed, [next]);
});

for (const response of [result({}), {code:1, killed:false, stdout:"", stderr:"Error: permission_denied: denied"}, {code:0, killed:true, stdout:"", stderr:""}]) {
	test(`failed inventory is not proof of closure: ${JSON.stringify(response)}`, async t => {
		const h = harness(t); h.state.response = () => response; h.lifecycle.track(binding(A)); h.ack(); await flush();
		assert.deepEqual(h.removed, []);
	});
}

test("explicit missing workspace is reconciled as a closed target", async t => {
	const h = harness(t); h.state.response = () => ({code:1, killed:false, stdout:"", stderr:"Error: not_found: Workspace not found"});
	h.lifecycle.track(binding(A)); await flush(); assert.equal(h.removed.length, 1);
});

test("inventory validator rejects malformed/ambiguous replies and accepts casing", () => {
	assert.equal(browserTargetPresent(binding(A), inventory(A)), true);
	assert.equal(browserTargetPresent(binding(A), {...inventory(A), window_id:W.toUpperCase()}), true);
	for (const listing of [{}, {...inventory(A), surfaces:[{}]}, inventory(A,A), {...inventory(A), window_id:"window:1"}]) {
		assert.throws(() => browserTargetPresent(binding(A), listing));
	}
	assert.equal(isMissingBrowserWorkspace(new Error("Error: not_found: Workspace not found")), true);
	assert.equal(isMissingBrowserWorkspace(new Error("Error: method_not_found: surface.list")), false);
});

for (const type of ["", " ", "browser ", "browser\n", "browser\r", "\tterminal", "browser\u001b", null, 42]) {
	test(`malformed inventory type preserves bindings and prevents page I/O: ${JSON.stringify(type)}`, async t => {
		for (const index of [0, 1]) {
			const h = harness(t), a = binding(A);
			h.state.listing.surfaces[index].type = type;
			assert.throws(() => browserTargetPresent(a, h.state.listing), /Invalid browser surface inventory/);
			h.lifecycle.track(a); h.ack(); await flush();
			assert.deepEqual(h.removed, []);
			const removed = [], calls = [];
			const transport = new CmuxAnnotationTransport({async exec(_cmd,args) {calls.push(args); return result(h.state.listing);}}, target => removed.push(target));
			await assert.rejects(() => transport.read(a, BOOT, [], new AbortController().signal), /Invalid browser surface inventory/);
			assert.deepEqual(removed, []);
			assert.equal(calls.length, 1, "malformed inventory must prevent page evaluation");
			h.state.listing.surfaces[index].type = index === 0 ? "terminal" : "browser";
			h.event("surface.moved", {surface_id:A}); await flush();
			assert.equal(browserTargetPresent(a, h.state.listing), true);
			assert.deepEqual(h.removed, [], "valid inventory can recover without reopening the browser");
		}
	});
}

test("unrelated well-formed surface kinds do not invalidate a browser inventory", () => {
	const listing = inventory(A);
	listing.surfaces.push({id:B, type:"future_preview"});
	assert.equal(browserTargetPresent(binding(A), listing), true);
});

test("annotation transport quietly reports verified closure without page eval", async () => {
	for (const response of [result(inventory()), {code:1, killed:false, stdout:"", stderr:"Error: not_found: Workspace not found"}]) {
		const removed = [], calls = [];
		const transport = new CmuxAnnotationTransport({async exec(_cmd,args) {calls.push(args); return response;}}, target => removed.push(target));
		const a = binding(A);
		await assert.rejects(() => transport.read(a, BOOT, [], new AbortController().signal));
		assert.deepEqual(removed, [a]); assert.equal(calls.length, 1); assert.equal(calls[0][4], "surface.list");
	}
});

function streamHarness(t) {
	const child = Object.assign(new EventEmitter(), {stdout:new PassThrough(), stderr:new PassThrough(), exitCode:null, signalCode:null});
	const frames = [], commands = [], kills = []; let failures = 0;
	child.kill = signal => {kills.push(signal); child.signalCode = signal ?? "SIGTERM"; child.emit("close"); return true;};
	const stop = openBrowserEvents(value => frames.push(value), () => failures++, (...args) => {commands.push(args); return child;});
	t.after(stop);
	return {child, frames, commands, kills, stop, get failures(){return failures;}};
}

test("event reader parses chunked JSONL and drains stderr without exposing it", t => {
	const h = streamHarness(t), line = JSON.stringify(frame("ack"));
	assert.equal(h.commands[0][0], "cmux"); assert.equal(h.commands[0][1][0], "events");
	assert.ok(h.commands[0][1].includes("surface.closed"));
	h.child.stdout.write(line.slice(0, 20)); assert.equal(h.frames.length, 0);
	h.child.stdout.write(line.slice(20)+"\n"+JSON.stringify(frame("heartbeat"))+"\n");
	h.child.stderr.write("private CLI diagnostics");
	assert.equal(h.frames.length, 2); assert.equal(h.failures, 0);
	h.stop(); assert.equal(h.kills.length, 1); assert.equal(h.failures, 0);
});

for (const text of ["not json\n", "[]\n", '{"type":"error"}\n', "x".repeat(65537), "x".repeat(65537)+"\n"]) {
	test(`event reader rejects invalid/oversized frame (${text.length} chars)`, t => {
		const h = streamHarness(t); h.child.stdout.write(text);
		assert.equal(h.failures, 1); assert.equal(h.kills.length, 1); assert.equal(h.frames.length, 0);
	});
}

test("spawn errors and stream exits disconnect once", t => {
	const h = streamHarness(t); h.child.emit("error", new Error("ENOENT")); h.child.emit("close");
	assert.equal(h.failures, 1);
});

test("silent event connections expire without holding the session open", t => {
	const jobs = [];
	t.mock.method(globalThis, "setTimeout", (callback, ms) => {const job = {callback, ms, unref(){}}; jobs.push(job); return job;});
	t.mock.method(globalThis, "clearTimeout", () => {});
	const h = streamHarness(t); assert.equal(jobs[0].ms, 45000); jobs.shift().callback();
	assert.equal(h.failures, 1); assert.equal(h.kills.length, 1);
});
